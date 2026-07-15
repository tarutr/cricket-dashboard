// src/playerPage.js
//
// Players destination (R2, decision 29; redesigned B7, decision 44a): a
// search-first single-player view rendered inside src/playerPopup.js's
// overlay shell. All SQL lives in src/playerData.js — this module only
// composes its results into HTML (via src/playerSections.js's pure builders)
// and wires the DOM. Metric vocabulary (labels, formatting) comes ONLY from
// src/metrics.js + table.js's formatValue (SPEC §8: one metrics module).
//
// Page scope is REDUCED to Format + Date range + Team type (see
// playerData.js's header) — gender and every leaderboard/drawer filter are
// inert here, and the scope line always says so, honestly (§8.4). On TOP of
// that page scope, this popup now has its OWN local "Filters" overlay
// (src/playerFilters.js) that narrows further (date/positions/opposition/vs)
// — popup-local, never touching the global store, cleared on close/player
// switch (see showPlayer() below).
//
// B7 (decision 44a) replaced the old stacked Batting-then-Bowling page with:
//   - an identity header with a real headshot or a designed monogram medallion
//   - a sticky [Batting | Bowling] toggle (default = the app's own discipline)
//     rendering a tight grid per discipline, the OTHER discipline lazy-loaded
//     on first switch and cached thereafter
//   - the Filters drawer described above
// Every section is still the SAME query from playerData.js — this is
// re-composition of existing fetches, not new aggregation shapes.

import {
  fetchProfile,
  fetchPlayerGender,
  searchPlayers,
  fetchBattingCore,
  fetchBattingPositions,
  fetchBattingOpposition,
  fetchBattingMatchups,
  fetchBowlingCore,
  fetchBowlingOpposition,
  fetchBowlingMatchups,
} from "./playerData.js";
import { getManifest } from "./db.js";
import { escHtml, escAttr } from "./html.js";
import { mountPlayerFilters } from "./playerFilters.js";
import {
  headerPhotoHTML,
  scopeLine,
  overlayPillsHTML,
  normalizeBattingCore,
  battingGridHTML,
  bowlingGridHTML,
} from "./playerSections.js";

/** Scope key: the page re-fetches only when the player OR this tuple changes
 * (playerData.js's scope — Format + Date + Team type). The popup's OWN
 * Filters overlay is a SEPARATE key (see cacheKeyFor) — a global scope change
 * invalidates both disciplines' caches, an overlay change invalidates them
 * too, but they're tracked independently so each has one job. */
function scopeKeyFor(state) {
  return JSON.stringify([state.formats, state.dateFrom, state.dateTo, state.teamType]);
}

/** Cache key for one discipline's fetched section data: changes whenever the
 * global scope OR the popup's local overlay changes — either invalidates
 * both disciplines' cached data (the other is simply re-fetched lazily, on
 * next switch, not eagerly). */
function cacheKeyFor(state, overlay) {
  return JSON.stringify([scopeKeyFor(state), overlay]);
}

// ── Fixed scope (R4 Wave 2, owner ruling) ────────────────────────────────────
// The header search is reachable from anywhere and isn't "a row of the
// table's current result set" the way clicking a name in the leaderboard is
// — so its popup must NOT inherit the table's applied Format/Date/Team type.
// mountPlayerPopup's `open(id, name, { fixedScope })` forwards that flag into
// showPlayer() below; `fixedScopeState`, once resolved, becomes the ONE
// object every scope-consuming call in this file reads instead of
// store.get() — see effectiveState(). Table-row entry (main.js's
// onPlayerClick, no opts) never sets fixedScope, so it reads the live global
// store exactly as before — byte-identical to pre-R4-Wave-2 behaviour. The
// popup's own "Find another player" search (R4 Wave 3) now PRESERVES the
// current popup's fixedScope for the next player: a header-search popup stays
// fixed-scope across in-popup navigation, a table-row popup stays table-scoped.

/**
 * The fixed full-history default: Since-2020-to-the-data's-max-date (same
 * bound math as filters.js's "Since 2020" preset — duplicated rather than
 * imported because applyPreset() is file-private there; getManifest() is the
 * same max-date source that preset itself reads via db.js), T20, both team
 * types, and the SEARCHED PLAYER'S OWN gender (never the table's — a
 * women's player found from a men's-view table must still resolve
 * correctly). `gender` is passed in already-resolved (see showPlayer/
 * loadAndRenderPlayer, which fetch it via playerData.js's
 * fetchPlayerGender before calling this) since it depends on which player
 * was searched, not on anything synchronous at open time.
 *
 * Note: gender is currently inert to every query this file's pipeline runs
 * (pageScopeClauses always passes includeGender:false — see playerData.js's
 * header, a player_id already pins the rows to one gender) — it's threaded
 * through here for correctness/future-proofing, not because it changes any
 * number rendered today. `fallbackGender` (the CALLER's store.get().gender —
 * this function is module-scope, outside mountPlayerPage's closure, so it
 * can't read the store itself) only fires if fetchPlayerGender found nothing
 * for this id, which pageScopeClauses would ignore either way.
 */
function buildFixedScopeState(gender, fallbackGender) {
  const manifest = getManifest();
  const minDate = manifest?.data?.min_match_date || null;
  const maxDate = manifest?.data?.max_match_date || null;
  let dateFrom = "2020-01-01";
  if (minDate && minDate > dateFrom) dateFrom = minDate; // never claim data earlier than the loaded snapshot
  let dateTo = maxDate || dateFrom;
  if (dateFrom > dateTo) dateFrom = dateTo; // defensive: never invert the window
  return {
    gender: gender || fallbackGender || "male",
    formats: ["T20"],
    dateFrom,
    dateTo,
    teamType: "both",
  };
}

function syncSegmented(el, value) {
  el.querySelectorAll(".segmented__btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.value === value);
  });
}

function activeOverlayCount(overlay) {
  if (!overlay) return 0;
  let n = 0;
  if (overlay.dateFrom || overlay.dateTo) n++;
  if (overlay.positions && overlay.positions.length) n++;
  if (overlay.opposition) n++;
  if (overlay.vs) n++;
  return n;
}

// ── Header / shell HTML ──────────────────────────────────────────────────────

function headerHTML(current, profile) {
  const heading = profile && profile.full_name ? profile.full_name : current.name;
  const showRegistryName = Boolean(profile && profile.full_name && profile.full_name !== current.name);
  let metaHTML = "";
  if (profile) {
    const role = profile.playing_role === "Unknown" ? null : profile.playing_role;
    const meta = [profile.country, role, profile.batting_style, profile.bowling_style].filter(Boolean).join(" · ");
    if (meta) metaHTML = `<p class="player-page__meta">${escHtml(meta)}</p>`;
  } else {
    metaHTML = `<p class="player-page__meta player-page__meta--note">No profile data for this player.</p>`;
  }
  return `
    <div class="player-page__header">
      ${headerPhotoHTML(heading, profile)}
      <div class="player-page__header-text">
        <h2 class="player-page__name">${escHtml(heading)}</h2>
        ${showRegistryName ? `<p class="player-page__registry-name">${escHtml(current.name)}</p>` : ""}
        ${metaHTML}
      </div>
    </div>`;
}

/** Sticky header row: back link + discipline toggle (left), Filters + Graph
 * (right). `showControls` gates toggle/Filters/Graph together — only the
 * fully-loaded page shell passes true (loading/error shells have a `current`
 * player but no confirmed innings yet, same precedent as the old
 * showGraphButton gate). */
function headerRowHTML({ showControls = false } = {}) {
  const toggleHTML = showControls
    ? `<div class="segmented player-page__discipline-toggle" data-role="discipline-toggle" role="group" aria-label="Discipline">
        <button type="button" class="segmented__btn" data-value="batting">Batting</button>
        <button type="button" class="segmented__btn" data-value="bowling">Bowling</button>
      </div>`
    : "";
  const filtersBtnHTML = showControls
    ? `<button type="button" class="btn btn--ghost player-page__filters-btn" data-role="open-player-filters">
        Filters <span class="filter-open-btn__count" data-role="filters-count" hidden></span>
      </button>`
    : "";
  const graphBtnHTML = showControls
    ? `<button type="button" class="btn btn--ghost player-page__graph-btn" data-role="graph-player">Graph this player</button>`
    : "";
  return `<div class="player-page__header-row">
      <div class="player-page__header-row-group player-page__header-row-group--left">
        <button type="button" class="link-btn player-page__back" data-role="back">&larr; Find another player</button>
        ${toggleHTML}
      </div>
      <div class="player-page__header-row-group player-page__header-row-group--right">
        ${filtersBtnHTML}
        ${graphBtnHTML}
      </div>
    </div>`;
}

function loadingShellHTML(current) {
  return `
    <div class="player-page">
      ${headerRowHTML()}
      <h2 class="player-page__name">${escHtml(current.name)}</h2>
      <p class="player-page__loading">Loading…</p>
    </div>`;
}

function errorShellHTML(current, err) {
  const message = (err && (err.userMessage || err.message)) || "Something went wrong loading this player.";
  return `
    <div class="player-page">
      ${headerRowHTML()}
      <h2 class="player-page__name">${escHtml(current.name)}</h2>
      <div class="error-box">
        <p>${escHtml(message)}</p>
        <button type="button" class="btn btn--primary" data-role="retry">Retry</button>
      </div>
    </div>`;
}

function pageShellHTML({ current, profile }) {
  return `
    <div class="player-page">
      ${headerRowHTML({ showControls: true })}
      ${headerHTML(current, profile)}
      <div class="player-page__scope-area" data-role="scope-area"></div>
      <div class="player-page__discipline-body" data-role="discipline-body"></div>
    </div>`;
}

// ── Controller ────────────────────────────────────────────────────────────────

export function mountPlayerPage(container, store, { onGraphPlayer } = {}) {
  let current = null; // { id, name } | null
  let scopeKey = null; // global scope this page was last rendered for
  let loadToken = 0;
  let searchDebounceId = null;

  let activeDiscipline = "batting"; // local to this popup instance
  let overlay = null; // popup-local Filters overlay — never touches the store
  let profile = null;
  let cacheKey = null; // cacheKeyFor(state, overlay) the cached data below matches
  const data = { batting: undefined, bowling: undefined }; // undefined=not fetched, "loading", "error", or the fetched {core, ...extra}

  // R4 Wave 2 (header-search entry): true for the lifetime of the CURRENT
  // showPlayer() call when opened via { fixedScope: true } (main.js's header
  // search only). fixedScopeState is the resolved override object (null
  // until the async gender lookup in loadAndRenderPlayer() below resolves,
  // and always null when fixedScope is false) — effectiveState() is the ONE
  // seam every scope-consuming call below reads through, so table-row entry
  // (fixedScope never set) is untouched: effectiveState() degrades to
  // store.get() exactly as every call site read it before this task.
  let fixedScope = false;
  let fixedScopeState = null;

  /** The state every scope-consuming call in this file should read. */
  function effectiveState() {
    return fixedScopeState || store.get();
  }

  // The filters-drawer overlay is `position: fixed` (see styles.css's
  // .player-filters-drawer) and must escape the popup's own scrolling body —
  // mounted as a sibling of the app's other overlay hosts (index.html's
  // #filter-drawer-host / #player-popup-host both live directly under
  // <body>), not nested inside `container`.
  const filtersHost = document.createElement("div");
  document.body.appendChild(filtersHost);
  const filters = mountPlayerFilters(filtersHost, {
    onApply: (newOverlay) => {
      overlay = newOverlay;
      invalidateCaches();
      renderScopeArea();
      loadDiscipline(activeDiscipline, { render: true });
    },
  });

  function invalidateCaches() {
    data.batting = undefined;
    data.bowling = undefined;
    cacheKey = null;
  }

  // ---------- Shared shell wiring ----------

  function bindShell(retryFn) {
    const backBtn = container.querySelector('[data-role="back"]');
    if (backBtn) {
      backBtn.addEventListener("click", () => {
        current = null;
        scopeKey = null;
        renderSearchMode();
      });
    }
    const retryBtn = container.querySelector('[data-role="retry"]');
    if (retryBtn) retryBtn.addEventListener("click", retryFn);

    const graphBtn = container.querySelector('[data-role="graph-player"]');
    if (graphBtn) {
      graphBtn.addEventListener("click", () => {
        if (onGraphPlayer && current) onGraphPlayer(current.id, current.name);
      });
    }

    const toggleEl = container.querySelector('[data-role="discipline-toggle"]');
    if (toggleEl) {
      syncSegmented(toggleEl, activeDiscipline);
      toggleEl.addEventListener("click", (e) => {
        const btn = e.target.closest(".segmented__btn");
        if (!btn || btn.dataset.value === activeDiscipline) return;
        activeDiscipline = btn.dataset.value;
        syncSegmented(toggleEl, activeDiscipline);
        loadDiscipline(activeDiscipline, { render: true });
      });
    }

    const filtersBtn = container.querySelector('[data-role="open-player-filters"]');
    if (filtersBtn) {
      filtersBtn.addEventListener("click", () => {
        if (!current) return;
        filters.open({ playerId: current.id, discipline: activeDiscipline, pageState: effectiveState(), overlay });
      });
    }

    // Identity photo (task 1, decision 44a): a broken/failed headshot URL
    // falls back to the monogram medallion — a CSS class flip (see styles.
    // css's .player-photo--broken rule), never a re-render, and never a
    // browser broken-image glyph.
    const photoImg = container.querySelector('[data-role="player-photo-img"]');
    if (photoImg) {
      photoImg.addEventListener("error", () => {
        photoImg.closest('[data-role="player-photo"]')?.classList.add("player-photo--broken");
      });
    }
  }

  function renderFiltersCount() {
    const el = container.querySelector('[data-role="filters-count"]');
    if (!el) return;
    const n = activeOverlayCount(overlay);
    el.hidden = n === 0;
    el.textContent = String(n);
  }

  function renderScopeArea() {
    const el = container.querySelector('[data-role="scope-area"]');
    if (!el) return;
    const state = effectiveState();
    el.innerHTML = `<p class="player-page__scope">${escHtml(
      scopeLine(state, overlay, { fixedDefault: fixedScope })
    )}</p>${overlayPillsHTML(overlay)}`;
    el.querySelectorAll(".pill__x").forEach((btn) => {
      btn.addEventListener("click", () => {
        clearOverlayDim(btn.dataset.dim);
      });
    });
    const resetBtn = el.querySelector('[data-role="reset-player-filters"]');
    if (resetBtn) resetBtn.addEventListener("click", () => clearOverlayDim(null));
    renderFiltersCount();
  }

  function clearOverlayDim(dim) {
    if (!dim) {
      overlay = null;
    } else if (overlay) {
      const next = { ...overlay };
      if (dim === "date") {
        next.dateFrom = null;
        next.dateTo = null;
      } else if (dim === "positions") {
        next.positions = [];
      } else if (dim === "opposition") {
        next.opposition = null;
      } else if (dim === "vs") {
        next.vs = null;
      }
      const empty = !next.dateFrom && !next.dateTo && next.positions.length === 0 && !next.opposition && !next.vs;
      overlay = empty ? null : next;
    }
    invalidateCaches();
    renderScopeArea();
    loadDiscipline(activeDiscipline, { render: true });
  }

  // ---------- Search mode ----------

  function renderSearchMode() {
    container.innerHTML = `
      <div class="player-page-search">
        <h2 class="player-page-search__heading">Players</h2>
        <input type="text" class="input player-page-search__input" placeholder="Find a player…" aria-label="Find a player" />
        <div class="player-page-search__results" aria-live="polite"></div>
      </div>`;
    const input = container.querySelector(".player-page-search__input");
    const resultsEl = container.querySelector(".player-page-search__results");
    input.addEventListener("input", () => {
      clearTimeout(searchDebounceId);
      const term = input.value;
      searchDebounceId = setTimeout(() => runSearch(term, resultsEl), 200);
    });
  }

  async function runSearch(term, resultsEl) {
    const t = term.trim();
    if (t.length < 2) {
      resultsEl.innerHTML = "";
      return;
    }
    const token = ++loadToken;
    let rows;
    try {
      rows = await searchPlayers(t);
    } catch {
      if (token !== loadToken) return;
      resultsEl.innerHTML = `<p class="player-page-search__empty">Search failed — try again.</p>`;
      return;
    }
    if (token !== loadToken) return;
    if (rows.length === 0) {
      resultsEl.innerHTML = `<p class="player-page-search__empty">No players match.</p>`;
      return;
    }
    resultsEl.innerHTML = rows
      .map((r) => {
        const meta = [r.country, r.playing_role === "Unknown" ? null : r.playing_role].filter(Boolean).join(" · ");
        const metaHTML = meta
          ? `<span class="player-page-search__item-meta">${escHtml(meta)}</span>`
          : `<span class="player-page-search__item-meta player-page-search__item-meta--muted">No profile available</span>`;
        return `<button type="button" class="player-page-search__item" data-id="${escAttr(r.id)}" data-name="${escAttr(r.name)}">
          <span class="player-page-search__item-name">${escHtml(r.name)}</span>
          ${metaHTML}
        </button>`;
      })
      .join("");
    resultsEl.querySelectorAll(".player-page-search__item").forEach((btn) => {
      // Keep the CURRENT popup's scope mode for the next player (R4 Wave 3):
      // a popup opened in fixedScope mode (header search — since-2020/T20/both
      // team types) stays in fixedScope when the user picks another player via
      // this in-popup search, instead of silently reverting to the table's
      // scope. A table-row-opened popup has fixedScope=false, so this passes
      // { fixedScope: false } and its behavior is unchanged.
      btn.addEventListener("click", () => showPlayer(btn.dataset.id, btn.dataset.name, { fixedScope }));
    });
  }

  // ---------- Player page ----------

  /** Fetch + render ONE discipline's core+extras. Cached per (scope, overlay);
   * a cache hit just re-renders instantly (no network). `render:true` swaps
   * the body immediately (toggle click / Filters apply); the initial load
   * always renders. */
  async function loadDiscipline(discipline, { render }) {
    const key = cacheKeyFor(effectiveState(), overlay);
    if (key !== cacheKey) {
      invalidateCaches();
      cacheKey = key;
    }
    if (data[discipline] !== undefined) {
      // Cache hit — including an already-in-flight "loading" placeholder, so
      // a second call for the same discipline (e.g. a fast double toggle)
      // never starts a second overlapping fetch. loadToken is deliberately
      // NOT bumped on this path: doing so would wrongly mark the OTHER
      // discipline's own in-flight fetch as "superseded" the next time it
      // resolves and checks its token.
      if (render) renderBody();
      return;
    }
    const playerRef = current;
    const token = ++loadToken;
    data[discipline] = "loading";
    if (render) renderBody();

    let result;
    try {
      result = await fetchDisciplineData(discipline, playerRef.id, effectiveState(), overlay);
    } catch (err) {
      if (token !== loadToken || current !== playerRef) return; // superseded — don't clobber newer data
      data[discipline] = { error: err };
      if (render) renderBody();
      return;
    }
    if (token !== loadToken || current !== playerRef) return; // superseded — don't clobber newer data
    data[discipline] = result;
    if (render) renderBody();
  }

  async function fetchDisciplineData(discipline, playerId, state, ov) {
    if (discipline === "batting") {
      const core = await fetchBattingCore(playerId, state, ov);
      const coreNorm = normalizeBattingCore(core);
      if (!coreNorm?.summary || Number(coreNorm.summary.innings) === 0) {
        return { core: coreNorm, positions: [], opposition: null, matchups: { coverage: null, coarse: [], fine: [] } };
      }
      // Owner decision 46: while a Vs bucket is active, playerSections.js's
      // battingGridHTML hides the position and opposition sections outright
      // (neither can split by Vs — PLAYER_SECTION_SUPPORT says so for both),
      // so skip fetching data nobody will see. Matchups is DIFFERENT: it
      // can't honor `vs` either (it IS the by-bowling-type breakdown; a
      // section can't pre-filter to the one bucket it exists to break out),
      // but it stays VISIBLE under Vs — so strip `vs` from its own overlay
      // rather than let it come back refused. This is a no-op when `vs`
      // isn't set (same object reference), so the byte-identical fast path
      // for an empty overlay is untouched.
      const isVs = coreNorm.source === "matchup_batting";
      const matchupsOverlay = ov && ov.vs ? { ...ov, vs: null } : ov;
      const [positions, opposition, matchups] = await Promise.all([
        isVs ? Promise.resolve([]) : fetchBattingPositions(playerId, state, ov),
        isVs || state.teamType !== "international" ? Promise.resolve(null) : fetchBattingOpposition(playerId, state, ov),
        fetchBattingMatchups(playerId, state, matchupsOverlay),
      ]);
      return { core: coreNorm, positions, opposition, matchups };
    }
    const core = await fetchBowlingCore(playerId, state, ov);
    if (!core || Array.isArray(core.unsupported) || Number(core.innings) === 0) {
      return { core, opposition: null, matchups: { coverage: null, hands: [] } };
    }
    const [opposition, matchups] = await Promise.all([
      state.teamType === "international" ? fetchBowlingOpposition(playerId, state, ov) : Promise.resolve(null),
      fetchBowlingMatchups(playerId, state, ov),
    ]);
    return { core, opposition, matchups };
  }

  function renderBody() {
    const el = container.querySelector('[data-role="discipline-body"]');
    if (!el) return;
    const entry = data[activeDiscipline];
    if (entry === undefined || entry === "loading") {
      el.innerHTML = `<p class="player-page__loading">Loading…</p>`;
      return;
    }
    if (entry && entry.error) {
      el.innerHTML = `<div class="error-box"><p>${escHtml(
        entry.error.userMessage || entry.error.message || "Couldn't load this tab."
      )}</p><button type="button" class="btn btn--primary" data-role="retry-tab">Retry</button></div>`;
      const retryTabBtn = el.querySelector('[data-role="retry-tab"]');
      if (retryTabBtn) {
        retryTabBtn.addEventListener("click", () => {
          data[activeDiscipline] = undefined;
          loadDiscipline(activeDiscipline, { render: true });
        });
      }
      return;
    }
    const state = effectiveState();
    el.innerHTML =
      activeDiscipline === "batting" ? battingGridHTML(state, entry.core, entry) : bowlingGridHTML(state, entry.core, entry);
  }

  async function loadAndRenderPlayer() {
    const playerRef = current;
    const wantsFixedScope = fixedScope;
    // Non-fixed (table-row entry, unchanged): scopeKey freezes on the live
    // store synchronously, exactly as before this task — nothing below in
    // this branch's timing changed. Fixed-scope popups defer scopeKey until
    // fixedScopeState resolves (below), since it depends on the async gender
    // lookup; nothing reads scopeKey in between (renderScopeArea/
    // loadDiscipline only run after that point either way).
    scopeKey = wantsFixedScope ? null : scopeKeyFor(store.get());
    const token = ++loadToken;

    container.innerHTML = loadingShellHTML(playerRef);
    bindShell(loadAndRenderPlayer);

    try {
      // R4 Wave 2: resolve the profile and (fixed-scope only) this player's
      // own gender in parallel — same one network round-trip the loading
      // shell already covers, so header-search popups open with no added
      // perceived delay over the pre-existing table-row path.
      const [profileResult, genderResult] = await Promise.all([
        fetchProfile(playerRef.id),
        wantsFixedScope ? fetchPlayerGender(playerRef.id) : Promise.resolve(null),
      ]);
      if (token !== loadToken || current !== playerRef) return;
      profile = profileResult;
      if (wantsFixedScope) {
        fixedScopeState = buildFixedScopeState(genderResult, store.get().gender);
        scopeKey = scopeKeyFor(fixedScopeState);
      }

      container.innerHTML = pageShellHTML({ current: playerRef, profile });
      bindShell(loadAndRenderPlayer);
      renderScopeArea();
      await loadDiscipline(activeDiscipline, { render: true });
    } catch (err) {
      if (token !== loadToken || current !== playerRef) return;
      container.innerHTML = errorShellHTML(playerRef, err);
      bindShell(loadAndRenderPlayer);
    }
  }

  // ---------- Public API ----------

  /**
   * `opts.fixedScope` (R4 Wave 2): set by main.js's header-search onOpenPlayer
   * wiring (via playerPopup.js's `open(id, name, opts)`), and — R4 Wave 3 —
   * carried forward by this file's own "Find another player" search result
   * buttons, which pass the CURRENT popup's `fixedScope` so in-popup navigation
   * preserves whichever scope the popup was opened in. main.js's onPlayerClick
   * (table-row entry) passes no opts, leaving it false, so effectiveState()
   * degrades to store.get() and a table-row popup behaves exactly as it always
   * has: scoped to the table's currently applied Format/Date/Team type.
   */
  function showPlayer(id, name, opts = {}) {
    current = { id, name };
    // Fresh player: reset everything popup-local (task 4/decision 44a — the
    // overlay and the discipline tab are cleared on every player switch, and
    // by extension on every popup reopen too, since main.js always routes a
    // reopen through this same showPlayer() call with an explicit id/name).
    activeDiscipline = store.get().discipline;
    overlay = null;
    invalidateCaches();
    profile = null;
    fixedScope = Boolean(opts.fixedScope);
    fixedScopeState = null; // resolved in loadAndRenderPlayer once gender is known
    filters.close();
    loadAndRenderPlayer();
  }

  function onShow() {
    if (!current) {
      renderSearchMode();
      return;
    }
    if (scopeKeyFor(effectiveState()) !== scopeKey) {
      loadAndRenderPlayer();
    }
    // Same player, same scope: the DOM from the last render is still
    // correct. For a fixed-scope popup effectiveState() always returns the
    // same frozen fixedScopeState object, so this is always false — a
    // header-search popup never silently re-scopes itself off a later table
    // filter change.
  }

  function onScopeChanged() {
    if (!current) return; // search mode: filters don't apply, nothing to do
    if (scopeKeyFor(effectiveState()) !== scopeKey) {
      loadAndRenderPlayer();
    }
  }

  return { onShow, onScopeChanged, showPlayer };
}
