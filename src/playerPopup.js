// src/playerPopup.js
//
// Player profile POP-UP (owner ruling at the R2 gate: profiles are an overlay
// over the current page, not a destination — the original D5 interaction
// model). Opens from any player name in the leaderboard; closes via the ×,
// clicking the backdrop, or Escape, returning to the page untouched behind it.
//
// The content is src/playerPage.js unchanged — including its internal
// "Find another player" search mode. Scope semantics are unchanged too: the
// popup reads Format + Date + Team type at open time (its cache key refetches
// on reopen if the scope moved while it was closed).
//
// "Graph this player" is currently INERT (owner note 17, fix round): the
// whole feature described in the paragraph below is DEFERRED to a later
// design phase, at the owner's request — the button stays visible (a
// deliberate placeholder) but clicking it does nothing. See the
// onGraphPlayer/graphBtnObserver comments at their call site, further down,
// for exactly how. Nothing described below was deleted — it's all still
// here, just unreachable until a future task re-wires the one line that used
// to call chooser.open().
//
// (Historical/future behavior, decision 46): playerPage.js's Graph button
// opens src/playerGraphChooser.js — a chooser modal OVER this popup — instead
// of jumping straight to Graphs (see that module's header for why). Only on
// the chooser's Confirm do we actually close the popup, switch to Graphs, and
// hand the choice to src/graph/graph.js's enterWithChoice(). main.js's own
// `onGraphPlayer` prop (a bare `(id, name) => {...}` that does its own store/
// view-switch + a plain roster add) is no longer this popup's path to Graphs
// — this module can't change main.js's callback contract (out of scope for
// this task), and that plain contract has no room for a chart type/metric
// anyway, so the switch below duplicates its ~6-line view-flip instead (see
// switchToGraphsView()) and calls graph.js's own richer entry point directly.
// `onGraphPlayer` is still accepted (main.js still passes it) but unused —
// kept only so this module's call signature doesn't have to change either.

import { mountPlayerPage } from "./playerPage.js";
import { mountPlayerGraphChooser } from "./playerGraphChooser.js";
import { enterWithChoice } from "./graph/graph.js";

export function mountPlayerPopup(hostEl, store, { onGraphPlayer } = {}) {
  hostEl.innerHTML = `
    <div class="player-popup" data-role="player-popup" hidden>
      <div class="player-popup__backdrop" data-role="popup-backdrop"></div>
      <div class="player-popup__panel" role="dialog" aria-modal="true" aria-label="Player profile" tabindex="-1" data-role="popup-panel">
        <button type="button" class="player-popup__close" data-role="popup-close" aria-label="Close">&times;</button>
        <div class="player-popup__body" data-role="popup-body"></div>
      </div>
    </div>
  `;

  const els = {
    popup: hostEl.querySelector('[data-role="player-popup"]'),
    backdrop: hostEl.querySelector('[data-role="popup-backdrop"]'),
    panel: hostEl.querySelector('[data-role="popup-panel"]'),
    closeBtn: hostEl.querySelector('[data-role="popup-close"]'),
    body: hostEl.querySelector('[data-role="popup-body"]'),
  };

  // Chooser modal (owner decision 46) — mounted as a sibling of this popup at
  // document.body, same "escape the popup's own scroll container" precedent
  // as playerFilters.js's drawer (see that module's own comment); its CSS
  // (.player-graph-chooser*, styles.css) sits at a higher z-index than
  // .player-popup so it visually sits OVER it, same idiom as
  // .player-filters-drawer already does.
  //
  // owner note 17 (fix round): the whole "Graph this player" feature below —
  // this chooser included — is DEFERRED to a later design phase. The chooser
  // module and its mount stay exactly as they were (never deleted, never
  // unwired here) so reviving the feature later is just re-pointing
  // onGraphPlayer below back at chooser.open(); the actual "do nothing" fix
  // is entirely in onGraphPlayer, a few lines down.
  const chooserHost = document.createElement("div");
  document.body.appendChild(chooserHost);
  const chooser = mountPlayerGraphChooser(chooserHost, {
    onConfirm: ({ chartType, metricKey, player }) => {
      close(); // the player popup itself — task 2's "close the chooser and the player popup"
      switchToGraphsView();
      enterWithChoice({ chartType, metricKey, player });
    },
  });

  // "Graph this player" made INERT (owner note 17, fix round): playerPage.js
  // has no notion of "popup" or "chooser" — it just reports which player was
  // clicked, by calling this callback (see that file's bindShell(), which
  // wires the button's click to `onGraphPlayer(current.id, current.name)`
  // unconditionally). Making this a no-op is therefore sufficient on its own
  // to guarantee the click has ZERO effect — no chooser, no jump to Graphs —
  // for every render of the button, with no dependency on DOM timing: this
  // closure is captured ONCE, here, at mount time, and playerPage.js reuses
  // the same reference on every one of its re-renders (popup open/reopen,
  // discipline toggle, Filters apply, retry, scope change while open).
  //
  // The button's own markup/click-wiring live in playerPage.js, outside this
  // task's owned files (playerSections.js/playerPopup.js/
  // playerGraphChooser.js only) — graphBtnObserver below gives it the
  // "disabled/inert affordance" the owner asked for (muted look + a "Coming
  // soon" tooltip) without editing that template, by re-applying it every
  // time the button (re)appears (playerPage.js recreates the whole header
  // row — and this button — on popup open/reopen and on global-scope changes
  // made while the popup is open).
  const page = mountPlayerPage(els.body, store, {
    onGraphPlayer: () => {
      // Intentionally does nothing. See the comment above and
      // graphBtnObserver below.
    },
  });

  const graphBtnObserver = new MutationObserver(() => {
    const btn = els.body.querySelector('[data-role="graph-player"]');
    if (!btn || btn.disabled) return;
    btn.disabled = true; // native disabled: no click/keyboard activation, dropped from tab order, for free
    btn.title = "Coming soon — graphing a player from their profile isn't available yet.";
  });
  graphBtnObserver.observe(els.body, { childList: true, subtree: true });

  /**
   * Flip Stats->Graphs the same way main.js's own applyView()/showGraphView()
   * do — duplicated here (not imported: those are main.js-private and this
   * task's brief doesn't touch main.js) rather than left undone, since
   * store.set() alone doesn't move these `hidden` attributes (main.js only
   * does that from its own explicit call sites, never reactively). Every
   * OTHER piece of chrome (scope sentence, pills, drawer badge) already
   * reacts to store.set({view}) on its own via main.js's store.subscribe(),
   * so only the imperative bits below need replicating.
   */
  function switchToGraphsView() {
    store.set({ view: "graph" });
    const tableArea = document.getElementById("table-area");
    const searchSection = document.getElementById("player-search-section");
    const graphArea = document.getElementById("graph-area");
    if (tableArea) tableArea.hidden = true;
    if (searchSection) searchSection.hidden = true;
    if (graphArea) graphArea.hidden = false;
    document.querySelectorAll('[data-role="view"] .segmented__btn').forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.value === "graph");
    });
  }

  function open(id, name) {
    chooser.close(); // defensive: a stale chooser shouldn't survive a reopen for a different player
    page.showPlayer(id, name);
    els.popup.hidden = false;
    els.body.scrollTop = 0;
    els.panel.focus();
  }

  function close() {
    chooser.close(); // defensive: never leave the chooser orphaned over a closed popup
    els.popup.hidden = true;
  }

  els.closeBtn.addEventListener("click", close);
  els.backdrop.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    // The chooser (mounted above, so its OWN Escape listener is registered
    // first) already stopImmediatePropagation()s and closes itself when it's
    // open — this only fires at all when the chooser was closed already, in
    // which case Escape does what it always did: close the popup.
    if (e.key === "Escape" && !els.popup.hidden) close();
  });

  return { open, close };
}
