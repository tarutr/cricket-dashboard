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

import { mountPlayerPage } from "./playerPage.js";

export function mountPlayerPopup(hostEl, store) {
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

  const page = mountPlayerPage(els.body, store);

  function open(id, name) {
    page.showPlayer(id, name);
    els.popup.hidden = false;
    els.body.scrollTop = 0;
    els.panel.focus();
  }

  function close() {
    els.popup.hidden = true;
  }

  els.closeBtn.addEventListener("click", close);
  els.backdrop.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.popup.hidden) close();
  });

  return { open, close };
}
