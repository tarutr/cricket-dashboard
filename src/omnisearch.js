// src/omnisearch.js
//
// Player-first omnisearch (B2R wave 2, decisions 42/44): the main search box
// stops being a leaderboard filter-as-you-type box. Typing (300ms debounce)
// opens a dropdown UNDER the input listing up to 8 matching players from the
// WHOLE database, regardless of the current leaderboard filters — clicking
// one opens that player's popup directly (main.js wires this to
// playerPopupController.open). The table underneath is NEVER touched by
// typing.
//
// The name-matching query is src/playerData.js's searchPlayers(), the same
// helper the player-popup search already uses: it matches every name a
// player has appeared under (player_matches name history), not just their
// registry name, so old names (e.g. "NR Sciver") still find the player under
// their current one, and it's gender/filter-agnostic by construction (no
// scope clauses at all).
//
// The dropdown's LAST row is always the explicit table-filter action —
// "Filter the table to names matching "<text>"" — because turning the search
// box back into a leaderboard filter is a deliberate, explicit choice now
// (decision 44's "explicit action is the trigger" rule), not a side effect of
// typing. Choosing it (click or Enter-with-no-row-highlighted) is the caller's
// job via the onFilterTable callback — this module only decides which row was
// chosen.
//
// onFilterTable also receives the player rows this dropdown already fetched
// for the current search term (B2R wave 3, decision 44c) — the caller (main.js's
// triggerTableSearch) uses them to tell an honest "no rows for this scope"
// empty table apart from a "these players aren't real" one, via a toast, without
// this module knowing anything about the table or toasts itself.

import { searchPlayers } from "./playerData.js";
import { escHtml as esc } from "./html.js";

const DEBOUNCE_MS = 300;
const MAX_ROWS = 8;

/**
 * Mount the omnisearch dropdown onto an <input> + a sibling results container
 * (the caller owns both elements' markup/positioning; this only fills the
 * results container and wires events).
 *
 * @param {HTMLInputElement} inputEl
 * @param {HTMLElement} resultsEl - popover panel, positioned via CSS under inputEl
 * @param {{onOpenPlayer?: (id: string, name: string) => void, onFilterTable?: (text: string, matches: Array<{id: string, name: string}>) => void}} callbacks
 */
export function mountOmnisearch(inputEl, resultsEl, { onOpenPlayer, onFilterTable } = {}) {
  let debounceId = null;
  let requestToken = 0;
  let rows = []; // last-fetched player rows for `currentTerm`
  let activeIndex = -1; // -1 = nothing highlighted (Enter -> the filter-table action)
  let isOpen = false;
  let currentTerm = "";

  function close() {
    if (!isOpen) return;
    isOpen = false;
    resultsEl.hidden = true;
    resultsEl.innerHTML = "";
    activeIndex = -1;
    inputEl.setAttribute("aria-expanded", "false");
  }

  function open() {
    isOpen = true;
    resultsEl.hidden = false;
    inputEl.setAttribute("aria-expanded", "true");
  }

  function rowMetaHTML(r) {
    const meta = [r.country, r.playing_role && r.playing_role !== "Unknown" ? r.playing_role : null]
      .filter(Boolean)
      .join(" · ");
    return meta
      ? `<span class="omnisearch__item-meta">${esc(meta)}</span>`
      : `<span class="omnisearch__item-meta omnisearch__item-meta--muted">No profile available</span>`;
  }

  // The trailing filter-table row's logical index is always rows.length —
  // one past the last player row, whether there are 0 or 8 of them.
  function render(term) {
    const parts = [];
    if (rows.length === 0) {
      parts.push(`<p class="omnisearch__empty">No players match &ldquo;${esc(term)}&rdquo;</p>`);
    } else {
      rows.forEach((r, i) => {
        parts.push(
          `<button type="button" class="omnisearch__item${i === activeIndex ? " is-active" : ""}" data-idx="${i}" role="option" aria-selected="${i === activeIndex}">` +
            `<span class="omnisearch__item-name">${esc(r.name)}</span>${rowMetaHTML(r)}` +
            `</button>`
        );
      });
    }
    const filterIdx = rows.length;
    parts.push(
      `<button type="button" class="omnisearch__item omnisearch__item--action${activeIndex === filterIdx ? " is-active" : ""}" data-idx="${filterIdx}" role="option" aria-selected="${activeIndex === filterIdx}">` +
        `Filter the table to names matching &ldquo;${esc(term)}&rdquo;` +
        `</button>`
    );
    resultsEl.innerHTML = parts.join("");
    resultsEl.querySelectorAll(".omnisearch__item").forEach((btn) => {
      btn.addEventListener("click", () => choose(Number(btn.dataset.idx), term));
    });
    open();
  }

  function choose(idx, term) {
    if (idx < rows.length) {
      const r = rows[idx];
      close();
      if (onOpenPlayer) onOpenPlayer(r.id, r.name);
    } else {
      // Snapshot `rows` (this dropdown's own last-fetched matches for `term`)
      // BEFORE close() — close() doesn't mutate `rows`, but this keeps the
      // snapshot's provenance explicit at the call site.
      const matches = rows.slice();
      close();
      if (onFilterTable) onFilterTable(term, matches);
    }
  }

  async function runSearch(term) {
    const token = ++requestToken;
    let result = [];
    try {
      result = await searchPlayers(term);
    } catch {
      // Degrade to "no players match" rather than a stuck dropdown or a
      // thrown error — the search is a convenience lookup, never a blocker.
      result = [];
    }
    if (token !== requestToken) return; // superseded by a newer keystroke
    rows = result.slice(0, MAX_ROWS);
    activeIndex = -1;
    render(term);
  }

  /** Enter pressed before the debounced search has opened the dropdown (task
   * 3 root cause, B1 polish): previously the keydown handler's `if (!isOpen)
   * return` silently swallowed this keystroke, so a normal "type, then hit
   * Enter" flow never reached choose()/onFilterTable at all — no query, no
   * toast, nothing — even though the debounced search a moment later would
   * have found the same matches. Runs the lookup immediately instead of
   * waiting out the debounce, then acts on its result: with no dropdown ever
   * rendered there's no row to have highlighted, so this is unambiguously the
   * filter-table action (same convention as Enter-with-no-highlight below —
   * rows.length is always the action row's index). Duplicates runSearch's
   * fetch (rather than calling it) so it does NOT render/open the dropdown
   * first, only to have choose() immediately close it again. */
  async function flushAndChoose(term) {
    const token = ++requestToken;
    let result = [];
    try {
      result = await searchPlayers(term);
    } catch {
      result = [];
    }
    if (token !== requestToken) return; // superseded by a newer keystroke meanwhile
    rows = result.slice(0, MAX_ROWS);
    choose(rows.length, term);
  }

  inputEl.addEventListener("input", () => {
    const term = inputEl.value.trim();
    currentTerm = term;
    clearTimeout(debounceId);
    if (term.length === 0) {
      close();
      rows = [];
      return;
    }
    debounceId = setTimeout(() => runSearch(term), DEBOUNCE_MS);
  });

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      close();
      return;
    }
    if (e.key === "Enter" && !isOpen) {
      // See flushAndChoose's doc comment — the bug this fixes.
      e.preventDefault();
      const term = inputEl.value.trim();
      if (term.length === 0) return;
      clearTimeout(debounceId);
      flushAndChoose(term);
      return;
    }
    if (!isOpen) return;
    const total = rows.length + 1; // +1 for the trailing filter-table action
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = activeIndex < total - 1 ? activeIndex + 1 : 0;
      render(currentTerm);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = activeIndex > 0 ? activeIndex - 1 : total - 1;
      render(currentTerm);
    } else if (e.key === "Enter") {
      e.preventDefault();
      // No row highlighted -> the filter-table action (task 5: "Enter with no
      // highlight = the filter-table action").
      const idx = activeIndex === -1 ? rows.length : activeIndex;
      choose(idx, currentTerm);
    }
  });

  document.addEventListener("click", (e) => {
    if (!isOpen) return;
    if (e.target === inputEl || resultsEl.contains(e.target)) return;
    close();
  });

  return { close };
}
