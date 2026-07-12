// src/filters.js
//
// The scope strip (owner decision 29: one slim filter bar + one "All filters"
// drawer, replacing the old three-row layout). This module keeps ONLY the
// filters common to every query — Gender, Format, Date range, Team type —
// plus the button that opens the drawer (src/drawer.js) holding everything
// else: Team, Min innings, Player profile, Innings (position/opposition),
// and Stat conditions (src/advanced.js).
//
// This module only renders/wires the DOM and calls store.set(...); it never
// queries the database directly — src/table.js owns re-querying on state
// change, and src/drawer.js owns the team/opposition option-list lookups.

import {
  FORMAT_BUCKETS,
  expandFormats,
  emptyProfile,
  profileSemiJoinSql,
  oppositionFilterActive,
  positionsFilterActive,
  regularPositionsFilterActive,
  eventFilterActive,
  venueFilterActive,
  escSql as esc,
} from "./state.js";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthOptionsHTML(minMonth, maxMonth, selected) {
  if (!minMonth || !maxMonth) return "";
  const [minY, minM] = minMonth.split("-").map(Number);
  const [maxY, maxM] = maxMonth.split("-").map(Number);
  const opts = [];
  for (let y = maxY; y >= minY; y--) {
    const mFrom = y === maxY ? maxM : 12;
    const mTo = y === minY ? minM : 1;
    for (let m = mFrom; m >= mTo; m--) {
      const val = `${y}-${String(m).padStart(2, "0")}`;
      opts.push(`<option value="${val}" ${val === selected ? "selected" : ""}>${MONTH_NAMES[m - 1]} ${y}</option>`);
    }
  }
  return opts.join("");
}

// ── Day-level dates (Batch 1B, task 1B-1) ───────────────────────────────────
// dateFrom/dateTo now accept EITHER the original "YYYY-MM" (month granularity)
// or a new "YYYY-MM-DD" (day granularity). isDayDate distinguishes the two by
// shape alone (both are produced by trusted internal code — the date pickers
// — never typed freely by a user into SQL, but esc() still runs on every
// interpolated value below as defense in depth, matching every other clause
// in this file). nextCalendarDay computes an exclusive upper bound one day
// past a given "YYYY-MM-DD", the day-granularity analogue of the month branch's
// existing "first day of the following month" trick — done via UTC Date
// arithmetic (never local time) so it can never drift a day from DST, mirroring
// state.js's monthsAgo helper.
const DAY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDayDate(value) {
  return DAY_DATE_RE.test(value);
}

function nextCalendarDay(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const ny = dt.getUTCFullYear();
  const nm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const nd = String(dt.getUTCDate()).padStart(2, "0");
  return `${ny}-${nm}-${nd}`;
}

/** The four filters that make up EVERY query's inescapable "core scope" —
 * gender / format / date window / team type — factored out of
 * buildScopeClauses (owner decision 46, task 3) so table.js's additive
 * pinned-player union (buildQuery) can compute "core scope only, still
 * applies even to a pinned player" without duplicating this logic or
 * depending on buildScopeClauses' internal clause ordering by inspection.
 * buildScopeClauses below ALWAYS starts its clause list with exactly this
 * function's output (same options, same order) before appending its own
 * caller-specific extras — table.js relies on that invariant to slice the
 * "leaderboard-only" remainder off a full buildScopeClauses() call. */
export function buildCoreScopeClauses(state, { includeGender = true } = {}) {
  const clauses = [];
  // Player-page queries (R2) filter by a specific player_id, so gender is
  // redundant there — every other caller keeps the gender clause.
  if (includeGender) clauses.push(`gender = '${esc(state.gender)}'`);

  const matchTypes = expandFormats(state.formats);
  if (matchTypes.length === 0) {
    clauses.push("FALSE"); // no format selected -> no rows, never "all"
  } else {
    clauses.push(`match_type IN (${matchTypes.map((t) => `'${esc(t)}'`).join(", ")})`);
  }

  // Day-level dates (Batch 1B): a "YYYY-MM-DD" dateFrom/dateTo takes a new
  // branch each; the ORIGINAL "YYYY-MM" branch below is untouched byte-for-byte,
  // so with no dates set, or dates in the original month format, this emits the
  // exact same clauses as before (baselines 2,813/2,049 unaffected).
  if (state.dateFrom) {
    if (isDayDate(state.dateFrom)) {
      // Day-level lower bound: the day itself, used directly (inclusive).
      clauses.push(`match_date >= DATE '${esc(state.dateFrom)}'`);
    } else {
      clauses.push(`match_date >= DATE '${esc(state.dateFrom)}-01'`);
    }
  }
  if (state.dateTo) {
    if (isDayDate(state.dateTo)) {
      // Day-level upper bound: inclusive of the whole day, via the FOLLOWING
      // calendar day as an exclusive bound — same trick as the month branch,
      // one granularity level down.
      clauses.push(`match_date < DATE '${esc(nextCalendarDay(state.dateTo))}'`);
    } else {
      // Inclusive of the whole "to" month: use the first day of the FOLLOWING month.
      const [y, m] = state.dateTo.split("-").map(Number);
      const nextY = m === 12 ? y + 1 : y;
      const nextM = m === 12 ? 1 : m + 1;
      clauses.push(`match_date < DATE '${nextY}-${String(nextM).padStart(2, "0")}-01'`);
    }
  }

  if (state.teamType === "international") clauses.push(`team_type = 'international'`);
  else if (state.teamType === "club") clauses.push(`team_type = 'club'`);
  // "both" -> no predicate
  return clauses;
}

/** Shared WHERE-clause builder for gender/format/date/team_type/(team) — used by
 * both the drawer's team/opposition-options lookups and src/table.js's main
 * query. Exported so table.js, drawer.js, and graph builders all build an
 * identical scope.
 *
 * D4 Piece 3 opt-ins (both default OFF because some callers query views that
 * lack the columns, e.g. player_matches):
 *   oppositionColumn — the view's opposition column (bowling_team for batting,
 *     batting_team for bowling). The opposition filter applies ONLY while
 *     teamType === "international" (decision 20; the controls grey out
 *     elsewhere, so an inert selection must never filter silently).
 *   includePositions — apply the batting-position filter (batting innings
 *     views only; positions are a batting concept, inert in bowling).
 *
 * Event / Venue (Batch 1B, task 1B-1) are NOT opt-in like the two above — they
 * always apply when state.event/state.venue are non-empty, for every caller,
 * via a match_id semi-join against `matches` (no column-name parameter needed;
 * see the inline comment at the clause itself). */
export function buildScopeClauses(
  state,
  { includeTeams = true, teamColumn, idColumn, oppositionColumn, includePositions = false, includeGender = true } = {}
) {
  const clauses = buildCoreScopeClauses(state, { includeGender });

  if (includeTeams && state.teams && state.teams.length > 0 && teamColumn) {
    clauses.push(`${teamColumn} IN (${state.teams.map((t) => `'${esc(t)}'`).join(", ")})`);
  }

  if (oppositionColumn && oppositionFilterActive(state)) {
    clauses.push(`${oppositionColumn} IN (${state.opposition.map((t) => `'${esc(t)}'`).join(", ")})`);
  }

  // Event / Venue (Batch 1B, task 1B-1): additive match-level filters via a
  // semi-join to `matches`, gender-scoped (not the caller's other scope dims —
  // `matches` is queried standalone here, so its own gender predicate is
  // spelled out fresh rather than reusing buildCoreScopeClauses). A plain,
  // NON-correlated IN-subquery: it only requires the CALLER's own FROM table to
  // carry a `match_id` column, which batting_innings, bowling_innings,
  // matchup_batting, and matchup_bowling — every view this function is ever
  // called against — all do (verified against the live schema). No column-name
  // option is needed (unlike teamColumn/oppositionColumn) because event_name
  // and venue live on ONE table (`matches`) regardless of caller. Both are OFF
  // by default (state.event / state.venue start as [] — see state.js), so this
  // is a no-op addition until a picker UI (1B-2) sets either array.
  if (eventFilterActive(state)) {
    clauses.push(
      `match_id IN (SELECT match_id FROM matches WHERE gender = '${esc(state.gender)}' AND event_name IN (${state.event
        .map((e) => `'${esc(e)}'`)
        .join(", ")}))`
    );
  }
  if (venueFilterActive(state)) {
    clauses.push(
      `match_id IN (SELECT match_id FROM matches WHERE gender = '${esc(state.gender)}' AND venue IN (${state.venue
        .map((v) => `'${esc(v)}'`)
        .join(", ")}))`
    );
  }

  if (includePositions && positionsFilterActive(state)) {
    // Positions are user-picked ints; coerce + drop anything non-integral so
    // nothing unsanitized reaches the SQL.
    const nums = state.positions.map(Number).filter(Number.isInteger);
    if (nums.length > 0) clauses.push(`batting_position IN (${nums.join(", ")})`);
  }

  // Profile-powered filters (D4.2): semi-join to matched player_ids. Only added
  // when an idColumn is supplied by the caller (the player_matches/innings views
  // and matchup views all have a join key; some scoped lookups don't) and a
  // profile filter is active. profileSemiJoinSql itself no-ops for women.
  if (idColumn) {
    const profileClause = profileSemiJoinSql(state, idColumn);
    if (profileClause) clauses.push(profileClause);
  }

  // R. Pos. (owner decision 46): restrict to players whose MOST COMMON batting
  // position within the current gender/format/date/team-type scope is in the
  // selection (ties break to the LOWEST position number). This is an ADDITIVE
  // per-player semi-join — parallel to the profile semi-join above — that never
  // touches the metric aggregates, so with the filter unset the query is
  // byte-identical to today. Modal position is ALWAYS derived from the batting
  // innings view (a batting-order concept), gated to plain mode by
  // regularPositionsFilterActive (matchup mode keeps its own striker-position
  // filter on `positions`, untouched). The inner scope reuses THIS builder with
  // includeTeams:false and NO idColumn, so it carries exactly the four scope
  // dims (gender/format/date/team_type) — team, opposition, profile and
  // regularPositions itself are all excluded — and it cannot recurse.
  if (idColumn && regularPositionsFilterActive(state)) {
    const nums = state.regularPositions.map(Number).filter(Number.isInteger);
    if (nums.length > 0) {
      const innerScope = buildScopeClauses(state, { includeTeams: false }).join(" AND ");
      clauses.push(
        `${idColumn} IN (SELECT player_id FROM (` +
          `SELECT batter_id AS player_id, batting_position AS pos, ` +
          `ROW_NUMBER() OVER (PARTITION BY batter_id ORDER BY COUNT(*) DESC, batting_position ASC) AS rn ` +
          `FROM batting WHERE ${innerScope} AND batting_position IS NOT NULL ` +
          `GROUP BY batter_id, batting_position) WHERE rn = 1 AND pos IN (${nums.join(", ")}))`
      );
    }
  }

  return clauses;
}

// Team type checkbox dropdown (decision 44b): the state value is still the
// single 'international' | 'club' | 'both' string (untouched) — these two
// checkboxes are just a different INPUT SHAPE over the same value. 'club' is
// relabeled "Domestic" for display only; the state/SQL value stays 'club'
// (buildScopeClauses, describeScope's TEAM_TYPE_LABELS key, everything else
// keeps reading 'club' — only this dropdown's visible text changes).
const TEAM_TYPE_OPTIONS = [
  { key: "international", label: "International" },
  { key: "club", label: "Domestic" },
];

/** Which of the two checkboxes are checked for a given teamType value. */
function teamTypeChecked(teamType) {
  return {
    international: teamType === "international" || teamType === "both",
    club: teamType === "club" || teamType === "both",
  };
}

/** Live summary label for the Team type dropdown button. */
function teamTypeSummaryLabel(teamType) {
  if (teamType === "both") return "International + Domestic";
  if (teamType === "international") return "International";
  return "Domestic"; // 'club'
}

/**
 * Live summary label for the Format dropdown button. Rule chosen (flagged
 * per task): "first selected + N more" rather than a full comma-join once
 * more than one bucket is selected — the comma-join reads cleaner at exactly
 * two ("T20, ODI") but grows unbounded at three-plus ("T20, ODI, ODM, Test"),
 * which defeats the point of a compact strip on mobile. "+N" stays a fixed
 * short width regardless of how many buckets are picked, so it's used
 * uniformly for every "more than one" case, not just the crowded ones.
 */
function formatSummaryLabel(formats) {
  const ordered = FORMAT_BUCKETS.filter((b) => formats.includes(b.key)).map((b) => b.key);
  if (ordered.length === 0) return "None"; // guarded against below — should not be reachable
  if (ordered.length === FORMAT_BUCKETS.length) return "All formats";
  if (ordered.length === 1) return ordered[0];
  return `${ordered[0]} +${ordered.length - 1}`;
}

/**
 * Portal-aware dropdown wiring (F1b, team_dropdown.png fix). Shared by every
 * dropdown opened INSIDE the Filters popup body — Format + Team type here,
 * Current/Historic team (drawer.js), R. Pos. + Batting position + Against
 * opposition (drawerInnings.js). The popup body scrolls (overflow:auto), which
 * CLIPS any absolutely-positioned panel opened within it; this helper moves the
 * panel to <body> with position:fixed while open so it escapes that clipping
 * ancestor, positions it under `toggleEl`, and repositions on popup-body scroll
 * + window resize. Mirrors the technique table.js uses for its columns popover
 * (getBoundingClientRect placement + a CAPTURING scroll listener so it also
 * catches scrolls on nested scrollable ancestors like the popup body) but is a
 * self-contained local helper — table.js is untouched.
 *
 * Open/close semantics (toggle click, outside-click, Escape, aria-expanded, the
 * `hidden` attribute) are handled here so every in-popup dropdown behaves
 * identically. `onOpen`/`onClose` run after the panel is shown/hidden (e.g. the
 * team dropdowns reset+focus their search box on open). Exported so drawer.js
 * and drawerInnings.js reuse the one implementation. Returns
 * `{ open, close, isOpen, reposition }`.
 */
export function wirePortalDropdown(toggleEl, panelEl, { onOpen, onClose } = {}) {
  // Remember the panel's original slot so close() can restore it in place —
  // then its closed-state CSS (position:absolute inside .dropdown/.team-dropdown)
  // and any parent-relative logic keep holding while it's not floating.
  const home = { parent: panelEl.parentNode, next: panelEl.nextSibling };
  let opened = false;

  function position() {
    const r = toggleEl.getBoundingClientRect();
    const margin = 8;
    panelEl.style.position = "fixed";
    panelEl.style.zIndex = "1000"; // above the modal panel (.filters-popup is z-index:100)
    // Override .dropdown__panel's min-width:100% — on <body> that resolves to
    // the viewport width. Pin it to the toggle's width instead.
    panelEl.style.minWidth = `${Math.round(r.width)}px`;
    panelEl.style.top = `${Math.round(r.bottom + 6)}px`;
    const width = panelEl.offsetWidth || Math.round(r.width);
    let left = Math.min(r.left, window.innerWidth - width - margin);
    left = Math.max(margin, left);
    panelEl.style.left = `${Math.round(left)}px`;
    panelEl.style.right = "auto";
    // Never taller than the space below the toggle — a long list scrolls within.
    const maxH = Math.max(140, Math.round(window.innerHeight - (r.bottom + 6) - margin));
    panelEl.style.maxHeight = `${maxH}px`;
    panelEl.style.overflowY = "auto";
  }

  const onScroll = () => {
    if (opened) position();
  };
  const onResize = () => {
    if (opened) position();
  };

  function open() {
    if (opened || toggleEl.disabled) return;
    opened = true;
    panelEl.hidden = false;
    document.body.appendChild(panelEl);
    position();
    toggleEl.setAttribute("aria-expanded", "true");
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    if (onOpen) onOpen();
  }

  function close() {
    if (!opened) return;
    opened = false;
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onResize);
    panelEl.hidden = true;
    // Clear the inline portal styles so the CSS layout resumes when restored.
    for (const p of ["position", "zIndex", "minWidth", "top", "left", "right", "maxHeight", "overflowY"]) {
      panelEl.style[p] = "";
    }
    if (home.next && home.next.parentNode === home.parent) home.parent.insertBefore(panelEl, home.next);
    else home.parent.appendChild(panelEl);
    toggleEl.setAttribute("aria-expanded", "false");
    if (onClose) onClose();
  }

  toggleEl.addEventListener("click", () => {
    if (opened) close();
    else open();
  });
  // Capture-phase so it also fires for clicks on nested scroll ancestors and
  // runs before the toggle's own listener (which then toggles): on the opening
  // click `opened` is still false here, so this no-ops and the toggle opens.
  document.addEventListener(
    "click",
    (e) => {
      if (!opened) return;
      if (panelEl.contains(e.target) || toggleEl === e.target || toggleEl.contains(e.target)) return;
      close();
    },
    true
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && opened) {
        close();
        e.stopPropagation(); // don't also close the Filters popup on the same Escape
      }
    },
    true
  );

  return { open, close, isOpen: () => opened, reposition: position };
}

/**
 * Mount the "Conditions" controls (Gender, Discipline, Format, Date range,
 * Team type) into `container` — the Filters popup's Conditions section body
 * (F1a). Calls `onChange()` after any state mutation so main.js can update the
 * pills/subtitle/badge (it no longer blanks the table — only the popup's
 * "Search" button re-queries). Store keys/values are unchanged.
 */
export function mountFilters(container, store, onChange, onFormatsChanged) {
  container.innerHTML = `
    <div class="filter-group filter-group--gender">
      <span class="filter-label">Gender</span>
      <div class="segmented" data-role="gender" role="group" aria-label="Gender">
        <button type="button" class="segmented__btn" data-value="male">Men</button>
        <button type="button" class="segmented__btn" data-value="female">Women</button>
      </div>
    </div>

    <div class="filter-group filter-group--format">
      <span class="filter-label">Format</span>
      <div class="dropdown" data-role="format-dropdown">
        <button type="button" class="select dropdown__toggle" data-role="format-toggle" aria-haspopup="true" aria-expanded="false"></button>
        <div class="dropdown__panel" data-role="format-panel" hidden>
          <div class="dropdown__list" data-role="format-list">
            ${FORMAT_BUCKETS.map(
              (b) => `<label class="dropdown__item">
                <input type="checkbox" data-format="${b.key}" />
                <span>${b.label}</span>
              </label>`
            ).join("")}
          </div>
        </div>
      </div>
    </div>

    <div class="filter-group filter-group--dates">
      <span class="filter-label">Date range</span>
      <div class="date-range">
        <select class="select" data-role="dateFrom" aria-label="From"></select>
        <span class="date-range__sep">–</span>
        <select class="select" data-role="dateTo" aria-label="To"></select>
      </div>
    </div>

    <div class="filter-group filter-group--teamtype">
      <span class="filter-label">Team type</span>
      <div class="dropdown" data-role="teamtype-dropdown">
        <button type="button" class="select dropdown__toggle" data-role="teamtype-toggle" aria-haspopup="true" aria-expanded="false"></button>
        <div class="dropdown__panel" data-role="teamtype-panel" hidden>
          <div class="dropdown__list" data-role="teamtype-list">
            ${TEAM_TYPE_OPTIONS.map(
              (o) => `<label class="dropdown__item">
                <input type="checkbox" data-teamtype="${o.key}" />
                <span>${o.label}</span>
              </label>`
            ).join("")}
          </div>
        </div>
      </div>
    </div>
  `;

  // Discipline (decision 44b) relocation: the segmented control is static
  // markup in index.html (main.js's module-level
  // `document.querySelector('[data-role="discipline"]')` binds to it at
  // script-load time, before this function has ever run — it now lives in the
  // Filters popup's Conditions section, as a sibling of this #filter-bar
  // container). We move the EXISTING node into its visual slot, second, right
  // after Gender, rather than re-rendering it: moving a DOM node doesn't
  // invalidate main.js's reference or its event listener, so its wiring keeps
  // working untouched wherever the node lives.
  const disciplineGroup = container.parentElement?.querySelector(".filter-group--discipline");
  const genderGroup = container.querySelector(".filter-group--gender");
  if (disciplineGroup && genderGroup) {
    genderGroup.insertAdjacentElement("afterend", disciplineGroup);
  }

  const els = {
    gender: container.querySelector('[data-role="gender"]'),
    dateFrom: container.querySelector('[data-role="dateFrom"]'),
    dateTo: container.querySelector('[data-role="dateTo"]'),
    formatToggle: container.querySelector('[data-role="format-toggle"]'),
    formatPanel: container.querySelector('[data-role="format-panel"]'),
    formatList: container.querySelector('[data-role="format-list"]'),
    teamtypeToggle: container.querySelector('[data-role="teamtype-toggle"]'),
    teamtypePanel: container.querySelector('[data-role="teamtype-panel"]'),
    teamtypeList: container.querySelector('[data-role="teamtype-list"]'),
  };

  function syncSegmented(el, value) {
    el.querySelectorAll(".segmented__btn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.value === value);
    });
  }

  function syncDateOptions(minMonth, maxMonth, state) {
    els.dateFrom.innerHTML = monthOptionsHTML(minMonth, maxMonth, state.dateFrom);
    els.dateTo.innerHTML = monthOptionsHTML(minMonth, maxMonth, state.dateTo);
  }

  // ---- Format dropdown (multi-select, apply-live, min-one guard) ----
  function syncFormatDropdown() {
    const state = store.get();
    els.formatToggle.textContent = formatSummaryLabel(state.formats);
    els.formatList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      const checked = state.formats.includes(cb.dataset.format);
      cb.checked = checked;
      // Guard against zero formats (the old chip row had no such guard — it
      // could reach zero and silently return no rows; this dropdown adds the
      // safety the task calls for): the sole remaining checked box is
      // disabled so it can't be the click that empties the selection.
      const sole = checked && state.formats.length === 1;
      cb.disabled = sole;
      cb.closest(".dropdown__item").classList.toggle("is-disabled", sole);
      cb.title = sole ? "At least one format must stay selected" : "";
    });
  }

  els.formatList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const state = store.get();
      const set = new Set(state.formats);
      const key = cb.dataset.format;
      if (cb.checked) {
        set.add(key);
      } else if (set.size <= 1) {
        cb.checked = true; // defensive: the disabled attribute should already prevent this
        return;
      } else {
        set.delete(key);
      }
      store.set({ formats: [...set], teams: [] });
      syncFormatDropdown();
      if (onFormatsChanged) onFormatsChanged();
      onChange();
    });
  });
  wirePortalDropdown(els.formatToggle, els.formatPanel);

  // ---- Team type dropdown (exactly two checkboxes, min-one guard) ----
  function syncTeamTypeDropdown() {
    const state = store.get();
    els.teamtypeToggle.textContent = teamTypeSummaryLabel(state.teamType);
    const checked = teamTypeChecked(state.teamType);
    const totalChecked = Number(checked.international) + Number(checked.club);
    els.teamtypeList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      const key = cb.dataset.teamtype;
      const isChecked = checked[key];
      cb.checked = isChecked;
      const sole = isChecked && totalChecked === 1;
      cb.disabled = sole;
      cb.closest(".dropdown__item").classList.toggle("is-disabled", sole);
      cb.title = sole ? "At least one team type must stay selected" : "";
    });
  }

  els.teamtypeList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const state = store.get();
      const current = teamTypeChecked(state.teamType);
      const key = cb.dataset.teamtype;
      const next = { ...current, [key]: cb.checked };
      if (!next.international && !next.club) {
        cb.checked = true; // defensive: the disabled attribute should already prevent this
        return;
      }
      const teamType = next.international && next.club ? "both" : next.international ? "international" : "club";
      store.set({ teamType, teams: [] });
      syncTeamTypeDropdown();
      onChange();
    });
  });
  wirePortalDropdown(els.teamtypeToggle, els.teamtypePanel);

  function render() {
    const state = store.get();
    syncSegmented(els.gender, state.gender);
    syncFormatDropdown();
    syncTeamTypeDropdown();
  }

  // ---- wire remaining events ----
  els.gender.addEventListener("click", (e) => {
    const btn = e.target.closest(".segmented__btn");
    if (!btn) return;
    // Switching gender clears team + profile filters: teams differ by gender, and
    // profile filters are men-only (cleared so the women's view is never silently
    // empty — the drawer's profile controls also grey out, decision 21).
    store.set({ gender: btn.dataset.value, teams: [], profile: emptyProfile() });
    render();
    onChange();
  });

  els.dateFrom.addEventListener("change", () => {
    store.set({ dateFrom: els.dateFrom.value });
    onChange();
  });
  els.dateTo.addEventListener("change", () => {
    store.set({ dateTo: els.dateTo.value });
    onChange();
  });

  render();

  return {
    render,
    setDateBounds(minMonth, maxMonth) {
      syncDateOptions(minMonth, maxMonth, store.get());
    },
  };
}
