// src/playerFiltersTab.js
//
// Tab-2 "Filters" — EMPTY SHELL (T-F1, decision 70/71). The player popup's
// old "Player Filters" overlay drawer is retired; the popup now has an
// Overview | Filters tab bar (src/playerPage.js), and this module owns the
// Filters panel. The real content — a table where each row is a user-defined
// filtered slice of the one open player's record — is a later, separately
// signed-off build (see .orchestrator/popup-tab2-build-plan.md, wave C / T-2).
// Today this file renders only the agreed empty-state text.
//
// Contract:
//   mountPlayerFiltersTab(container, { store, playerId, discipline, pageState })
//     -> { show(playerId, discipline, pageState), destroy() }
//
//   `container` — an element this module owns exclusively; playerPage.js
//     never writes into it directly (it only toggles its `hidden` attribute
//     when switching tabs).
//   `store` — the app's global state store (src/state.js). Accepted (and
//     threaded into `show`, below, via the initial mount options) so the
//     real T-2 build — which needs Search-Conditions-shaped option lookups
//     for its per-row scope/palette — doesn't require a signature change.
//     Unused today.
//   `playerId` / `discipline` / `pageState` — the popup's current player id,
//     active discipline ("batting" | "bowling"), and page scope (Format +
//     Date range + Team type — playerData.js's scope shape). Passed once at
//     mount time and again on every `show()` call.
//
//   `show(playerId, discipline, pageState)` — called by playerPage.js
//     whenever the Filters tab becomes the active tab, OR the active
//     player/discipline/page-scope changes while it's already active (same
//     "re-render on relevant change" idiom as playerPage.js's own
//     loadDiscipline). The empty shell has nothing to fetch, so this is a
//     synchronous, unconditional re-render; a later build will diff the
//     incoming values against what it last rendered to decide whether to
//     re-fetch anything.
//   `destroy()` — tears down anything this module registered outside
//     `container` itself. Nothing is registered today (no document-level
//     listeners, no portalled DOM) — kept for lifecycle symmetry with the
//     retired drawer's own open()/close() contract, and so a later build that
//     DOES register global listeners (e.g. a portalled per-row editor popup,
//     per the build plan's palette reuse) has a defined place to unwind them.
//     playerPage.js calls this before every re-mount (player switch, full
//     page re-render) and never touches `container`'s children itself.

function render(container) {
  container.innerHTML = `<p class="player-page__note player-page__note--muted">No filtered rows yet</p>`;
}

export function mountPlayerFiltersTab(container, { store, playerId, discipline, pageState } = {}) {
  render(container);

  function show(nextPlayerId, nextDiscipline, nextPageState) {
    // No fetch yet — the empty shell just stays the empty shell. Real build
    // (T-2) reads nextPlayerId/nextDiscipline/nextPageState here.
    render(container);
  }

  function destroy() {
    container.innerHTML = "";
  }

  return { show, destroy };
}
