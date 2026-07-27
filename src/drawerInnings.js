// src/drawerInnings.js
//
// The individual filter-editor controls mounted into the condition builder's
// rows (src/drawer.js). Each is a self-contained `{ sync }` controller that
// renders/wires its own DOM and calls store.set(...); drawer.js mounts them
// once and just shows/hides their row by presence, so they survive the numeric
// builder's rebuilds (their option caches + portal wiring never get torn down).
//
//   mountBattingPosition  — MATCHUP-ONLY striker/own batting-position filter
//                           (state.positions); self-hides outside matchup mode.
//   mountRegularPositions — "R. Pos." (state.regularPositions, decision 46):
//                           plain-mode filter on a player's most common batting
//                           position within scope (modal semi-join lives in
//                           filters.js). Both disciplines + both genders.
//   mountOpposition       — "Against opposition" (state.opposition); enabled for
//                           every team type (decision 51, R5-F #14 — reverses the
//                           old international-only gate, decision 20).
//   mountTeam             — "Played for" (state.teams); single gender-scoped team
//                           picker (owner 1B-2 removed the Current/Historic split).
//   mountEvent            — "Event" (state.event, Batch 1B); gender-scoped.
//   mountVenue            — "Venue" (state.venue, Batch 1B); gender-scoped.
//
// Team/Opposition/Event/Venue share mountScopedMultiSelect(): a thin wrapper
// over searchSelect.js's mountSearchMultiSelect (portal:true, so its panel
// escapes the Filters popup's overflow clip) fed the relevance-ranked option
// lists from playerData.js (searchTeams/searchEvents/searchVenues). A9
// (decision 47e): those lists now scope to the FULL Search Conditions —
// gender + format + date + team type — so the four callers below pass the active
// state.formats + state.dateFrom/state.dateTo alongside gender + team type. This
// changes only which OPTIONS are OFFERED; each picker still writes the SAME state
// field it always did, so the built query and every leaderboard/graph number is
// unchanged. Options load lazily (on the row becoming visible / first open) and
// reload when ANY scope dimension changes — gender, team type, format, or date
// (the cacheKey below carries all four). ROUND 3 task 8 (team type): on
// International the Event list drops domestic-only competitions like the IPL.
//
// CASCADING (owner rule, this pass): every one of those option lists ALSO respects
// the OTHER advanced match filters currently picked — pick Event = County
// Championship and the Venue list holds only county grounds; pick Team = India and
// the Opposition list holds only the teams India faced. A list never narrows by
// its OWN filter (`siblingExclude` / the `role` passed to searchTeams), so the
// Event list stays the full in-scope vocabulary while an event is selected, and
// removing a filter re-expands the others without touching what is already picked
// — except for a pick this scope can no longer satisfy at all, which is dropped
// (reconcilePicks below: mountStage's ruled behaviour, now shared by every list).
// The SQL half lives in ONE place (playerData.js siblingOptionClauses, over the
// shared predicate fragments in filters.js); the cache-key half is
// optionCacheKey() below, and both take the same self-exclusion list.
// Team/Event/Venue rows show a "<name>  N games" meta; Opposition keeps its plain
// list (no meta) and, since decision 51 (R5-F #14), is enabled for every team type.

import { wirePortalDropdown } from "./filters.js";
import {
  matchupVsActive,
  FIELDING_KIND_OPTIONS,
  FIELDING_PHASE_OPTIONS,
  FIELDING_POSITIONS,
  RESULT_OPTIONS,
  RESULT_ALL,
  RESULT_CONDITION_OPTIONS,
  RESULT_CONDITION_ALL,
  STAGE_ALL,
  STAGE_NONE,
  STAGE_NONE_LABEL,
  TOSS_RESULT_OPTIONS,
  TOSS_DECISION_OPTIONS,
  INNINGS_ORDER_OPTIONS,
} from "./state.js";
import { searchTeams, searchEvents, searchVenues, searchEventSeasons, searchStages } from "./playerData.js";
import { canonicalStage } from "./canonicalNames.js";
import { query } from "./db.js";
import { mountSearchMultiSelect } from "./searchSelect.js";
import { escHtml, escAttr } from "./html.js";

const POSITIONS = Array.from({ length: 12 }, (_, i) => i + 1);

// ── Cascading option lists: the shared cache-key fingerprint ─────────────────
// Every DB-derived option list (Team / Opposition / Event / Season / Venue /
// Stage) now cross-filters by the OTHER advanced match filters that are picked —
// playerData.js's matchOptionScope does the SQL half (see siblingOptionClauses
// there for the sender/receiver rules and self-exclusion). This is the UI half:
// each list caches its options under a scope key, so that key MUST also carry
// every sibling selection it depends on, or the list serves stale options after a
// sibling changes. One shared builder keyed the same way for all six, using the
// same sender keys as the SQL side: each list excludes exactly its OWN filter, so
// the key changes precisely when something that narrows the list changes. (Team
// and Opposition share one loader but are two filters, so each excludes only its
// own half — the Team key carries `opposition` and vice versa, matching what
// searchTeams actually narrows by for that role.)
//
// eventSeasons is serialised per SELECTED event only (the predicate reads no
// other key, so an orphan key must not trigger a pointless reload) and in stored
// order (a reorder changes the emitted IN-list, so it should reload).

/** The Search-Conditions half of every option-list cache key (gender / team type
 * / formats / date window) — unchanged by the cascading pass. */
function optionScopeKey(s) {
  return `${s.gender}|${s.teamType}|${(s.formats || []).join(",")}|${s.dateFrom || ""}|${s.dateTo || ""}`;
}

/** The sibling-selection half: every cascading sender EXCEPT the ones this list
 * must ignore. `exclude` mirrors playerData.js's sender keys exactly ("event"
 * also covering that event's season narrowing, as in the SQL builder). */
function optionSiblingKey(s, exclude = []) {
  const skip = new Set(exclude);
  const list = (arr) => (arr || []).join("~");
  const events = s.event || [];
  const seasons = skip.has("event") || skip.has("eventSeasons")
    ? ""
    : events
        .map((e) => `${e}:${JSON.stringify((s.eventSeasons || {})[e] || null)}`)
        .join("~");
  return [
    skip.has("event") ? "" : list(events),
    seasons,
    skip.has("venue") ? "" : list(s.venue),
    skip.has("stage") ? "" : list(s.stage),
    skip.has("teams") ? "" : list(s.teams),
    skip.has("opposition") ? "" : list(s.opposition),
    skip.has("resultCondition") ? "" : list(s.resultCondition),
    skip.has("tossDecision") ? "" : list(s.tossDecision),
  ].join("|");
}

/** The full cache key for an option list: Search Conditions + the siblings it
 * cross-filters by. */
function optionCacheKey(s, exclude = []) {
  return `${optionScopeKey(s)}||${optionSiblingKey(s, exclude)}`;
}

// ── Cascading option lists: the shared ALL-OR-NOTHING reconcile ──────────────
// Cross-filtered options are offered with OR-logic across your picks: with
// Venue = {Mission Road, Gelephu} the Stage list offers Final (Mission Road
// hosted Finals) AND Semi-Final (Gelephu did). The keep test must use the SAME
// standard as that offer test, so it is judged over the WHOLE selection, not
// value by value:
//
//   at least one non-sentinel pick still in the freshly-loaded list
//        → keep the selection EXACTLY as it is (no write, nothing dropped)
//   every real pick gone
//        → fall back to this filter's own "no narrowing" shape (the ruled
//          Stage behaviour: `[]` for venue/event/teams/opposition,
//          `[STAGE_ALL]` for stage), so results WIDEN instead of stranding a
//          zero-row filter the user cannot see.
//
// Judging each value on its own (the previous rule) made the app depend on the
// ORDER the form was filled in: with the two venues above, ticking Final first
// deleted Gelephu — which contributes nothing WHILE Final is the only stage —
// and nothing ever brought it back, so ticking Semi-Final afterwards left the
// legitimate "either venue, either knockout round" query unbuildable in that
// click order. All-or-nothing removes that asymmetry.
//
// WHY KEEPING A DEAD PICK IS SAFE FOR THE NUMBERS (Rule 1): a loader's list is
// the COMPLETE set of values available for the current scope + siblings (no
// LIMIT anywhere, and the search term only ever reorders — it never filters rows
// out). So a picked value that is absent from a freshly-loaded list cannot be
// satisfied by any match in scope: it is a dead disjunct in its own IN-list, and
// keeping it in — exactly like removing it — leaves the result set of the built
// query untouched. The only intentional result change is the fallback above.
//
// A kept-but-dead pick must never become invisible: each picker renders it as a
// muted, still-un-tickable row in its own dropdown (see DEAD_PICK_NOTE below,
// mountSearchMultiSelect's `keepMissingSelected`, and the dead-row blocks in
// mountAllMultiSelect / mountEventSeasons). Unticked options that are merely
// irrelevant stay HIDDEN — this never re-expands a narrowed list.
//
// CONVERGENCE: a reconcile writes state → the state changes some other list's
// cache key → that list reloads → it reconciles too. That settles, and more
// easily than before: the only write is a whole-selection reset, which strictly
// shrinks the total number of picks (finitely many) and never adds one. A reset
// also WIDENS its filter, and a widened filter can only ever GROW the other
// lists — growing a list can only turn dead picks live, never the reverse — so
// nothing can flip back and forth.

/** Shown on a picked value that the current filter combination has made
 * impossible. Kept in ONE place so every picker says the same thing. */
const DEAD_PICK_NOTE = "no matches with your current filters";

/**
 * Reconcile one filter's picks against the option list just loaded for it.
 * Returns the next selection, or `null` when nothing changed (the caller must
 * then NOT write — that guard is what makes the cycle above converge).
 *
 * @param {string[]} cur       the filter's current selection
 * @param {Set<string>} allowed the values the freshly-loaded list offers
 * @param {object} opts
 * @param {string[]} opts.sentinels values that are never dropped because they are
 *   not vocabulary at all (Stage's "All"); they also don't count as survivors.
 * @param {string[]} opts.inactive  this filter's OWN "no narrowing" representation
 *   — `[]` for venue/event/teams/opposition, `[STAGE_ALL]` for stage. Each picker
 *   keeps its existing shape; no new sentinel is introduced.
 */
function reconcilePicks(cur, allowed, { sentinels = [], inactive = [] } = {}) {
  if (!Array.isArray(cur) || cur.length === 0) return null; // filter not applied
  const keep = new Set(sentinels);
  const real = cur.filter((v) => !keep.has(v));
  if (real.length === 0) return null; // sentinels only → nothing is narrowing
  if (real.some((v) => allowed.has(v))) return null; // ≥1 survivor → keep the LOT
  const next = inactive; // nothing survives → this filter's "no narrowing" shape
  const same = next.length === cur.length && next.every((v, i) => v === cur[i]);
  return same ? null : next;
}

/**
 * Live summary label for a position dropdown's toggle button. Up to three
 * picked positions list out in full ("1, 2, 3"); four or more collapse to a
 * count ("4 selected") so the toggle never grows past a short phrase.
 */
function positionsSummaryLabel(positions) {
  if (!positions || positions.length === 0) return "Any position";
  const sorted = [...positions].sort((a, b) => a - b);
  if (sorted.length <= 3) return sorted.join(", ");
  return `${sorted.length} selected`;
}

/**
 * Mount the MATCHUP-ONLY Batting position multi-select. `embedded` suppresses
 * the outer filter-label (the condition row already names it). Returns `{ sync }`.
 */
export function mountBattingPosition(container, store, onChange, { embedded = false } = {}) {
  container.innerHTML = `
    <div class="filter-group filter-group--positions" data-role="positions-group">
      ${embedded ? "" : `<span class="filter-label">Batting position</span>`}
      <div class="dropdown" data-role="positions-dropdown">
        <button type="button" class="select dropdown__toggle" data-role="positions-toggle" aria-haspopup="true" aria-expanded="false">Any position</button>
        <div class="dropdown__panel" data-role="positions-panel" hidden>
          <div class="dropdown__list" data-role="positions-list">
            ${POSITIONS.map(
              (p) => `<label class="dropdown__item">
                <input type="checkbox" data-position="${p}" />
                <span>${p}</span>
              </label>`
            ).join("")}
          </div>
        </div>
      </div>
      <span class="profile-note" data-role="positions-hint" hidden>Filters the position of the batters faced</span>
    </div>
  `;

  const els = {
    group: container.querySelector('[data-role="positions-group"]'),
    toggle: container.querySelector('[data-role="positions-toggle"]'),
    panel: container.querySelector('[data-role="positions-panel"]'),
    list: container.querySelector('[data-role="positions-list"]'),
    hint: container.querySelector('[data-role="positions-hint"]'),
  };

  function updateToggleLabel() {
    els.toggle.textContent = positionsSummaryLabel(store.get().positions);
  }

  const dropdown = wirePortalDropdown(els.toggle, els.panel);

  els.list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const value = Number(cb.dataset.position);
      const current = new Set(store.get().positions);
      if (cb.checked) current.add(value);
      else current.delete(value);
      store.set({ positions: [...current] });
      updateToggleLabel();
      onChange();
    });
  });

  /** MATCHUP-ONLY (decision 46): live only while a matchup "Vs" selection is
   * active — in matchup_batting it's the batter's own position, in
   * matchup_bowling the position of the striker faced. Plain mode uses R. Pos.
   * instead, so this hides entirely outside matchup mode. */
  function sync() {
    const state = store.get();
    const matchupOn = matchupVsActive(state);
    els.group.hidden = !matchupOn;
    if (!matchupOn) {
      dropdown.close();
      return;
    }
    els.toggle.disabled = false;
    updateToggleLabel();
    const selected = new Set(state.positions);
    els.list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = selected.has(Number(cb.dataset.position));
    });
    // Bowling-matchup hint: this filter narrows the BATTERS faced, not the
    // bowler's own (nonexistent) position — say so plainly.
    els.hint.hidden = !(state.discipline === "bowling" && matchupOn);
  }

  sync();
  return { sync };
}

const REGULAR_POSITIONS = Array.from({ length: 11 }, (_, i) => i + 1);

/**
 * Mount the "R. Pos." (regular position) multi-select (decision 46). Binds to
 * `state.regularPositions` — a player matches when their MOST COMMON batting
 * position within scope is in the selection (the semi-join lives in filters.js).
 * BATTING contexts only (plain batting AND batting matchup, Wave 4b/decision 47a);
 * hides in every bowling context. Both genders. `embedded` suppresses the outer
 * filter-label. Returns `{ sync }`.
 */
export function mountRegularPositions(container, store, onChange, { embedded = false } = {}) {
  const DESC = "Regular position — where this player most often bats";
  container.innerHTML = `
    <div class="filter-group filter-group--rpos" data-role="rpos-group">
      ${embedded ? "" : `<span class="filter-label" title="${escAttr(DESC)}">R. Pos.</span>`}
      <div class="dropdown" data-role="rpos-dropdown">
        <button type="button" class="select dropdown__toggle" data-role="rpos-toggle" aria-haspopup="true" aria-expanded="false" title="${escAttr(DESC)}">Any position</button>
        <div class="dropdown__panel" data-role="rpos-panel" hidden>
          <div class="dropdown__list" data-role="rpos-list">
            ${REGULAR_POSITIONS.map(
              (p) => `<label class="dropdown__item">
                <input type="checkbox" data-position="${p}" />
                <span>${p}</span>
              </label>`
            ).join("")}
          </div>
        </div>
      </div>
    </div>
  `;

  const els = {
    group: container.querySelector('[data-role="rpos-group"]'),
    toggle: container.querySelector('[data-role="rpos-toggle"]'),
    panel: container.querySelector('[data-role="rpos-panel"]'),
    list: container.querySelector('[data-role="rpos-list"]'),
  };

  function updateToggleLabel() {
    els.toggle.textContent = positionsSummaryLabel(store.get().regularPositions);
  }

  const dropdown = wirePortalDropdown(els.toggle, els.panel);

  els.list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const value = Number(cb.dataset.position);
      const current = new Set(store.get().regularPositions);
      if (cb.checked) current.add(value);
      else current.delete(value);
      store.set({ regularPositions: [...current] });
      updateToggleLabel();
      onChange();
    });
  });

  function sync() {
    const state = store.get();
    // R. Pos. is a BATTING concept (Wave 4b, decision 47a): the control shows in
    // every batting context — plain batting AND batting matchup, where it sits
    // alongside the striker-position control — and hides in every bowling context
    // (plain or matchup), where the striker-position control is the only position
    // filter. (Previously plain-mode-only, both disciplines.)
    const show = state.discipline === "batting";
    els.group.hidden = !show;
    if (!show) {
      dropdown.close();
      return;
    }
    updateToggleLabel();
    const selected = new Set(state.regularPositions);
    els.list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = selected.has(Number(cb.dataset.position));
    });
  }

  sync();
  return { sync };
}

// ── Fielding SLICE pickers (fielding rebuild) ───────────────────────────────
// Three multi-select checkbox dropdowns that narrow WHICH wicket-events the
// Catches/Stumpings/Run-outs/Dismissals-Effected metrics count, by the event's
// OWN dims — dismissed-batter position (state.fielding.positions), dismissal kind
// (.kinds), phase (.phases). Same self-contained `{ sync }` shape and portal
// dropdown as mountBattingPosition above, so they slot into the condition
// builder's singleton rows the same way. PLAIN mode only: the fielding metrics
// live in the plain buildQuery (its fielding_cte join) — matchup Vs mode has no
// fielding, so these self-hide there (mirrors mountBattingPosition's matchup gate,
// inverted).

/** Generic checkbox multi-select over one list on state.fielding. `field` is
 * "positions" | "kinds" | "phases"; `options` is [{value,label}] (value is the
 * literal written to state — number for positions, string for kind/phase);
 * `summaryFn(selectedValues)` renders the toggle label. `embedded` suppresses the
 * outer filter-label (the condition row already names it). Returns `{ sync }`. */
function mountFieldingSlicePicker(container, store, onChange, { field, options, anyLabel, summaryFn, embedded = false, label }) {
  const setField = (values) =>
    store.set({ fielding: { ...(store.get().fielding || {}), [field]: values } });
  const getField = () => (store.get().fielding && store.get().fielding[field]) || [];

  container.innerHTML = `
    <div class="filter-group filter-group--positions" data-role="fld-group">
      ${embedded ? "" : `<span class="filter-label">${escHtml(label || "")}</span>`}
      <div class="dropdown" data-role="fld-dropdown">
        <button type="button" class="select dropdown__toggle" data-role="fld-toggle" aria-haspopup="true" aria-expanded="false">${escHtml(anyLabel)}</button>
        <div class="dropdown__panel" data-role="fld-panel" hidden>
          <div class="dropdown__list" data-role="fld-list">
            ${options
              .map(
                (o) => `<label class="dropdown__item">
                <input type="checkbox" data-fld-value="${escAttr(String(o.value))}" />
                <span>${escHtml(o.label)}</span>
              </label>`
              )
              .join("")}
          </div>
        </div>
      </div>
    </div>
  `;

  const els = {
    group: container.querySelector('[data-role="fld-group"]'),
    toggle: container.querySelector('[data-role="fld-toggle"]'),
    panel: container.querySelector('[data-role="fld-panel"]'),
    list: container.querySelector('[data-role="fld-list"]'),
  };

  // value coercion: positions are numbers, kind/phase are strings. Read the
  // option's declared type off `options` so the state array carries native types
  // (so buildFieldingSliceClauses' Number.isInteger / IN-list logic is honored).
  const valueOf = (raw) => {
    const opt = options.find((o) => String(o.value) === raw);
    return opt ? opt.value : raw;
  };

  function updateToggleLabel() {
    els.toggle.textContent = summaryFn(getField());
  }

  const dropdown = wirePortalDropdown(els.toggle, els.panel);

  els.list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const value = valueOf(cb.dataset.fldValue);
      const current = getField().slice();
      const idx = current.findIndex((v) => String(v) === String(value));
      if (cb.checked) {
        if (idx === -1) current.push(value);
      } else if (idx !== -1) {
        current.splice(idx, 1);
      }
      setField(current);
      updateToggleLabel();
      onChange();
    });
  });

  /** Fielding lives only in PLAIN mode (its fielding_cte join is in buildQuery,
   * not buildMatchupQuery), so hide entirely while a matchup "Vs" bucket is
   * active. */
  function sync() {
    const state = store.get();
    const matchupOn = matchupVsActive(state);
    els.group.hidden = matchupOn;
    if (matchupOn) {
      dropdown.close();
      return;
    }
    updateToggleLabel();
    const selected = new Set(getField().map((v) => String(v)));
    els.list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = selected.has(cb.dataset.fldValue);
    });
  }

  sync();
  return { sync };
}

/** Fielding: dismissed-batter position slice (state.fielding.positions, 1–11). */
export function mountFieldingPosition(container, store, onChange, opts = {}) {
  return mountFieldingSlicePicker(container, store, onChange, {
    field: "positions",
    options: FIELDING_POSITIONS.map((p) => ({ value: p, label: String(p) })),
    anyLabel: "Any position",
    summaryFn: (vals) => {
      if (!vals || vals.length === 0) return "Any position";
      const sorted = [...vals].sort((a, b) => a - b);
      return sorted.length <= 3 ? sorted.join(", ") : `${sorted.length} selected`;
    },
    label: "Dismissed position",
    ...opts,
  });
}

/** Fielding: dismissal-kind slice (state.fielding.kinds). */
export function mountFieldingKind(container, store, onChange, opts = {}) {
  return mountFieldingSlicePicker(container, store, onChange, {
    field: "kinds",
    options: FIELDING_KIND_OPTIONS,
    anyLabel: "Any dismissal",
    summaryFn: (vals) => {
      if (!vals || vals.length === 0) return "Any dismissal";
      if (vals.length === 1) return FIELDING_KIND_OPTIONS.find((o) => o.value === vals[0])?.label || vals[0];
      return `${vals.length} selected`;
    },
    label: "Dismissal kind",
    ...opts,
  });
}

/** Fielding: phase slice (state.fielding.phases). */
export function mountFieldingPhase(container, store, onChange, opts = {}) {
  return mountFieldingSlicePicker(container, store, onChange, {
    field: "phases",
    options: FIELDING_PHASE_OPTIONS,
    anyLabel: "Any phase",
    summaryFn: (vals) => {
      if (!vals || vals.length === 0) return "Any phase";
      if (vals.length === 1) return FIELDING_PHASE_OPTIONS.find((o) => o.value === vals[0])?.label || vals[0];
      return `${vals.length} selected`;
    },
    label: "Fielding phase",
    ...opts,
  });
}

// ── Match-context pickers (Wave 6) ──────────────────────────────────────────
// Five categorical filters keyed off the MATCH's context, available in batting,
// bowling AND matchup views (unlike the fielding slices, they have no matchup
// gate). Four sit in the "Match context" group of the "+ Add condition…" picker;
// Stage moved up into the "Match" group beside Event (polish item 3). Toss result /
// toss decision / innings order are fixed-vocabulary checkbox multi-selects over a
// TOP-LEVEL state array; Result (FIX A) is an "All + specifics" multi-select
// carrying a NESTED Result Condition sub-picker (FIX B / polish item 4,
// state.resultCondition) directly below it; Stage is the same "All + specifics"
// component over a scope-loaded vocabulary, plus a "Knockout" convenience button.
// Each is the same self-contained `{ sync }` controller as the pickers above and
// slots into a singleton row in drawer.js. None writes anything but its own state
// key(s), so the query stays byte-identical until a value narrows something (see
// filters.js buildMatchContextClauses).

/** Short toggle summary for a token multi-select: 0 → anyLabel; 1 → that
 * option's label; >1 → "N selected". */
function tokenSummary(vals, options, anyLabel) {
  if (!vals || vals.length === 0) return anyLabel;
  if (vals.length === 1) return options.find((o) => String(o.value) === String(vals[0]))?.label || String(vals[0]);
  return `${vals.length} selected`;
}

/** Generic checkbox multi-select over a TOP-LEVEL state array `field`
 * (result / tossResult / tossDecision / inningsOrder). `options` is
 * [{value,label}] with string values. `embedded` suppresses the outer label (the
 * condition row already names it). Returns `{ sync }`. */
function mountTokenMultiSelect(container, store, onChange, { field, options, anyLabel, label, embedded = false }) {
  const get = () => store.get()[field] || [];
  const set = (vals) => store.set({ [field]: vals });

  container.innerHTML = `
    <div class="filter-group filter-group--positions" data-role="mc-group">
      ${embedded ? "" : `<span class="filter-label">${escHtml(label || "")}</span>`}
      <div class="dropdown" data-role="mc-dropdown">
        <button type="button" class="select dropdown__toggle" data-role="mc-toggle" aria-haspopup="true" aria-expanded="false">${escHtml(anyLabel)}</button>
        <div class="dropdown__panel" data-role="mc-panel" hidden>
          <div class="dropdown__list" data-role="mc-list">
            ${options
              .map(
                (o) => `<label class="dropdown__item">
                <input type="checkbox" data-mc-value="${escAttr(String(o.value))}" />
                <span>${escHtml(o.label)}</span>
              </label>`
              )
              .join("")}
          </div>
        </div>
      </div>
    </div>`;

  const els = {
    toggle: container.querySelector('[data-role="mc-toggle"]'),
    panel: container.querySelector('[data-role="mc-panel"]'),
    list: container.querySelector('[data-role="mc-list"]'),
  };
  const updateLabel = () => {
    els.toggle.textContent = tokenSummary(get(), options, anyLabel);
  };
  wirePortalDropdown(els.toggle, els.panel);

  els.list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const value = cb.dataset.mcValue;
      const current = get().slice();
      const idx = current.findIndex((v) => String(v) === value);
      if (cb.checked) {
        if (idx === -1) current.push(value);
      } else if (idx !== -1) {
        current.splice(idx, 1);
      }
      set(current);
      updateLabel();
      onChange();
    });
  });

  function sync() {
    updateLabel();
    const selected = new Set(get().map((v) => String(v)));
    els.list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = selected.has(cb.dataset.mcValue);
    });
  }

  sync();
  return { sync };
}

// ── "All + specifics" multi-select (FIX A/B; Stage joined it, polish item 3) ──
// The ONE shared "All + specifics" picker: a checkbox list led by an "All" box
// that means "no narrowing". Used by the Result outcome picker, the nested Result
// Condition picker AND (polish item 3) the Stage picker, so all three behave
// identically. Semantics (mirror the Format dropdown's min-one):
//   • "All" checked ⟺ the stored array is [allValue] (or empty). While checked,
//     the All box is DISABLED (you switch away by checking a specific), so the
//     selection can never fall into an empty/undefined state.
//   • Checking a specific option removes "All" and adds that option.
//   • Unchecking the last remaining specific snaps back to "All" ([allValue]).
// NB the Event → Season sub-picker deliberately does NOT use this component: its
// "All seasons" box is a plain select-all/clear-all TOGGLE (owner ruling, polish
// item 2) rather than a disabled-while-checked sentinel, so it is its own control.
//
// `options` is the specific options only ({value,label}[], EXCLUDING the "All"
// pseudo-option — the component renders the All box itself). It may also be a
// FUNCTION returning that array, for a picker whose vocabulary is loaded async
// from the data (Stage) — it is re-read on every render.
// `quick` optionally adds one convenience button above the list ({label, onClick},
// e.g. Stage's "Knockout games"); `hiddenWhen`/`hiddenNote` optionally hide the
// whole dropdown and show a plain note in its place when there is nothing to
// choose (Stage with ≤1 named value in scope — polish item 3).
// The stored array is [allValue] for All, else the specific tokens (in `options`
// order). Returns `{ sync }`.
//
// DEAD PICKS: with the all-or-nothing reconcile a stored value can outlive its
// own option list (Stage = {Final, Semi-Final} while a venue narrows the list to
// Final alone). Such a value is rendered as a muted, still-un-tickable box at the
// top of the list rather than vanishing — see the reconcilePicks header.
// `optionsReady` lets an async picker (Stage) say "my vocabulary hasn't loaded
// yet", so a slow load doesn't paint every pick dead for a moment.
function mountAllMultiSelect(
  container,
  store,
  onChange,
  { field, allValue, options, allLabel, label, embedded = false, headLabel, nested = false, quick = null, hiddenWhen = null, hiddenNote = "", optionsReady = null }
) {
  const getOptions = typeof options === "function" ? options : () => options;
  const get = () => store.get()[field] || [];
  const set = (vals) => store.set({ [field]: vals });
  const specifics = () => get().filter((v) => String(v) !== String(allValue));
  const isAll = () => specifics().length === 0; // empty OR [allValue] → All
  /** Picked specifics with no option row right now (see DEAD PICKS above). */
  const deadSpecifics = () => {
    if (optionsReady && !optionsReady()) return [];
    const known = new Set(getOptions().map((o) => String(o.value)));
    return specifics().map(String).filter((v) => !known.has(v));
  };
  /** Canonical value order for a write: dead picks (shown first) then options. */
  const valueOrder = () => [...deadSpecifics(), ...getOptions().map((o) => String(o.value))];

  container.innerHTML = `
    <div class="filter-group filter-group--positions${nested ? " nested-pick" : ""}" data-role="mc-group">
      ${headLabel ? `<div class="nested-pick__head">${escHtml(headLabel)}</div>` : ""}
      ${!headLabel && !embedded ? `<span class="filter-label">${escHtml(label || "")}</span>` : ""}
      <div class="dropdown" data-role="mc-dropdown">
        <button type="button" class="select dropdown__toggle" data-role="mc-toggle" aria-haspopup="true" aria-expanded="false">${escHtml(allLabel)}</button>
        <div class="dropdown__panel" data-role="mc-panel" hidden>
          ${quick ? `<div class="dropdown__quick"><button type="button" class="text-btn" data-role="mc-quick">${escHtml(quick.label)}</button></div>` : ""}
          <div class="dropdown__list" data-role="mc-list"></div>
        </div>
      </div>
      ${hiddenWhen ? `<span class="profile-note" data-role="mc-note" hidden>${escHtml(hiddenNote)}</span>` : ""}
    </div>`;

  const els = {
    dropdown: container.querySelector('[data-role="mc-dropdown"]'),
    toggle: container.querySelector('[data-role="mc-toggle"]'),
    panel: container.querySelector('[data-role="mc-panel"]'),
    list: container.querySelector('[data-role="mc-list"]'),
    quick: container.querySelector('[data-role="mc-quick"]'),
    note: container.querySelector('[data-role="mc-note"]'),
  };

  const updateLabel = () => {
    const sp = specifics();
    const opts = getOptions();
    els.toggle.textContent =
      sp.length === 0
        ? allLabel
        : sp.length === 1
        ? opts.find((o) => String(o.value) === String(sp[0]))?.label || String(sp[0])
        : `${sp.length} selected`;
  };

  const dropdown = wirePortalDropdown(els.toggle, els.panel);

  function renderList() {
    const all = isAll();
    const sel = new Set(specifics().map(String));
    const opts = getOptions();
    const allBox = `<label class="dropdown__item${all ? " is-disabled" : ""}">
      <input type="checkbox" data-mc-all ${all ? "checked disabled" : ""} />
      <span>${escHtml(allLabel)}</span>
    </label>`;
    // Picks the current filter combination has made impossible: ticked, muted,
    // annotated — and fully clickable, so un-ticking one removes it for good.
    const deadBoxes = deadSpecifics()
      .map(
        (v) => `<label class="dropdown__item dropdown__item--dead">
        <input type="checkbox" data-mc-value="${escAttr(v)}" checked />
        <span>${escHtml(v)}</span>
        <span class="dropdown__item-note">${escHtml(DEAD_PICK_NOTE)}</span>
      </label>`
      )
      .join("");
    const specBoxes = opts
      .map(
        (o) => `<label class="dropdown__item">
        <input type="checkbox" data-mc-value="${escAttr(String(o.value))}" ${sel.has(String(o.value)) ? "checked" : ""} />
        <span>${escHtml(o.label)}</span>
      </label>`
      )
      .join("");
    els.list.innerHTML = allBox + deadBoxes + specBoxes;
    els.list.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.hasAttribute("data-mc-all")) {
          // Disabled while checked, so this only fires when re-checking All →
          // clear the specifics.
          if (cb.checked) set([allValue]);
        } else {
          const value = cb.dataset.mcValue;
          const cur = specifics();
          let next;
          if (cb.checked) {
            next = cur.includes(value) ? cur : [...cur, value];
          } else {
            next = cur.filter((v) => v !== value);
          }
          // Keep value order stable (dead picks first, then option order — so an
          // unrelated tick can never quietly drop one); empty → snap back to All.
          next = valueOrder().filter((v) => next.includes(v));
          set(next.length ? next : [allValue]);
        }
        updateLabel();
        renderList();
        onChange();
      });
    });
  }

  if (els.quick && quick) {
    els.quick.addEventListener("click", () => {
      quick.onClick({ setValues: (vals) => set(vals.length ? vals : [allValue]) });
      updateLabel();
      renderList();
      onChange();
    });
  }

  function sync() {
    // Nothing to choose (e.g. Stage with ≤1 named value in this scope): hide the
    // dropdown entirely and say so plainly, rather than offering a one-item list.
    if (hiddenWhen) {
      const hide = Boolean(hiddenWhen());
      if (hide) dropdown.close();
      els.dropdown.hidden = hide;
      if (els.note) els.note.hidden = !hide;
      if (hide) return;
    }
    updateLabel();
    renderList();
  }

  sync();
  return { sync };
}

// Result outcome options / Result Condition options WITHOUT their leading "All"
// pseudo-option (the mountAllMultiSelect component renders the All box itself).
const RESULT_SPECIFIC_OPTIONS = RESULT_OPTIONS.filter((o) => o.value !== RESULT_ALL);
const RESULT_CONDITION_SPECIFIC_OPTIONS = RESULT_CONDITION_OPTIONS.filter((o) => o.value !== RESULT_CONDITION_ALL);

/** Result filter (state.result) with the nested Result Condition sub-picker
 * (FIX A/B; renamed from "Result Type" in polish item 4). The Result OUTCOME
 * multi-select (Won / Lost / Drawn / Tied / No result, led by "All") sits on the
 * parent row next to its label; DIRECTLY BELOW it — exactly like the Event →
 * Season nesting — an indented child row carries the Result Condition sub-picker
 * (All / Normal / Super Over / D/L / VJD / Awarded / Fewer Wickets), shown
 * whenever the Result CONDITION is present (state.result non-empty; drawer.js
 * seeds both to ["all"] on add). Result and Result Condition are INDEPENDENT
 * WHERE conditions (outcome vs `match_winner`; condition vs `method` + the
 * super-over facet) — the nesting is purely UI. Returns `{ sync }`. */
export function mountResult(container, store, onChange, opts = {}) {
  const embedded = Boolean(opts.embedded);
  container.innerHTML = `
    <div class="filter-group filter-group--result" data-role="result-wrap">
      <div data-role="result-ms"></div>
      <div class="result-condition" data-role="result-condition" hidden></div>
    </div>`;
  const msHost = container.querySelector('[data-role="result-ms"]');
  const rcHost = container.querySelector('[data-role="result-condition"]');

  const rcMs = mountAllMultiSelect(rcHost, store, onChange, {
    field: "resultCondition",
    allValue: RESULT_CONDITION_ALL,
    options: RESULT_CONDITION_SPECIFIC_OPTIONS,
    allLabel: "All conditions",
    headLabel: "Result Condition",
    nested: true,
  });

  function syncResultCondition() {
    // The sub-picker shows whenever the Result condition is present (result set
    // to at least ["all"] on add). Empty result = condition not added = hidden.
    const present = (store.get().result || []).length > 0;
    rcHost.hidden = !present;
    if (present) rcMs.sync();
  }

  const resultMs = mountAllMultiSelect(msHost, store, () => { syncResultCondition(); onChange(); }, {
    field: "result",
    allValue: RESULT_ALL,
    options: RESULT_SPECIFIC_OPTIONS,
    allLabel: "All results",
    label: "Result",
    embedded,
  });

  return {
    sync() {
      resultMs.sync();
      syncResultCondition();
    },
  };
}
/** Toss result filter (state.tossResult) — Won toss / Lost toss. */
export function mountTossResult(container, store, onChange, opts = {}) {
  return mountTokenMultiSelect(container, store, onChange, {
    field: "tossResult", options: TOSS_RESULT_OPTIONS, anyLabel: "Any toss result", label: "Toss result", ...opts,
  });
}
/** Toss decision filter (state.tossDecision) — Chose to bat / field. */
export function mountTossDecision(container, store, onChange, opts = {}) {
  return mountTokenMultiSelect(container, store, onChange, {
    field: "tossDecision", options: TOSS_DECISION_OPTIONS, anyLabel: "Any toss decision", label: "Toss decision", ...opts,
  });
}
/** Innings-order filter (state.inningsOrder) — Batted first / Bowled first. */
export function mountInningsOrder(container, store, onChange, opts = {}) {
  return mountTokenMultiSelect(container, store, onChange, {
    field: "inningsOrder", options: INNINGS_ORDER_OPTIONS, anyLabel: "Any innings order", label: "Innings order", ...opts,
  });
}

// ── Stage picker (state.stage) ──────────────────────────────────────────────
// A scope-loaded "All + specifics" picker (the SHARED mountAllMultiSelect, same
// as Result — polish item 3) over CANONICAL stage labels (name normalization,
// backlog #5 — the raw `event_stage` values folded so casing/hyphen variants
// collapse to one option), plus a "Knockout games" convenience button. state.stage
// stores the canonical labels and filters.js buildMatchContextClauses expands each
// back to its raw spelling set for `event_stage IN (…)`, so a picked "Semi-Final"
// matches every raw spelling. The QUERY is unaffected by which OPTIONS are shown.
//
// Polish item 3 changes, all OPTIONS-side or sentinel-side:
//   • "All" leads the list and is the no-narrowing default (drawer.js seeds
//     stage=["all"] when the condition is added), exactly like Result.
//   • "No Stage" (STAGE_NONE) is offered whenever the scope actually contains
//     matches with no round name — the 20,689 `event_stage IS NULL` rows (98.8% of
//     red-ball domestic). Offered only when present in scope, for the same reason
//     the named list is scope-filtered: an option that can only return zero rows
//     is not a choice.
//   • The option list CROSS-FILTERS by the selected Event(s): with an Event picked,
//     only stages that occur in THAT event are listed (canonical → raw aliases
//     expanded, so every sponsor era of a merged event counts). Red Ball +
//     Domestic + County Championship therefore lists NO named stages — all 1,429
//     of its matches have a NULL stage — where before it leaked Super Eight/Final
//     in from other competitions.
//   • With ≤1 named stage in scope there is nothing to choose, so the dropdown is
//     not rendered at all (a plain note takes its place) and any leftover
//     narrowing snaps back to "All" so nothing invisible can stay applied.
//
// KNOCKOUT — EXPLICIT VETTED LIST (FIX 1): the "Knockout games" button used to
// classify stages with a keyword regex, which was brittle against `event_stage`
// being free text. It now selects the in-scope stages present in this
// owner-vetted, exhaustive set of the 42 knockout `event_stage` values (every
// distinct knockout value in the current data; cross-checked against the events).
// The remaining 11 distinct values are deliberately EXCLUDED — group/round-robin
// stages (Super League / Super Sixes / Super 10 / Super Eight / Super Four /
// Super Three / First Round / Group Stage / Qualifying Group) and two data-error
// stray values ('T20' / 'ODI'). Kept as a clearly-named constant Set so a future
// name-collapse (e.g. folding the "Semi Final" / "Semi-Final" / "Semi-final"
// casing variants into one) can remap membership in one place.
const KNOCKOUT_STAGES = new Set([
  "Final",
  "Semi Final",
  "Quarter Final",
  "Eliminator",
  "3rd Place Play-Off",
  "Qualifier 2",
  "Qualifier 1",
  "5th Place Play-Off",
  "7th Place Play-Off",
  "Semi-Final",
  "Qualifier",
  "Challenger",
  "Knockout",
  "Play-off",
  "Preliminary Final",
  "Quarter-Final",
  "Preliminary Quarter Final",
  "Quarter-final",
  "Semi-final",
  "4th Place Play-Off",
  "9th Place Play-Off",
  "Elimination Final",
  "Play-Off",
  "Preliminary quarter-final",
  "Qualifier 3",
  "3rd Place Play-off",
  "Play-off Semi-Final",
  "Qualifying Play-off",
  "Trophy Semi Final",
  "11th Place Play-Off",
  "13th Place Play-Off",
  "15th Place Play-Off",
  "5th Place Play-Off Semi Final",
  "Qualifier 4",
  "Qualifying Play-off Semi-Final",
  "Race to the Final",
  "Shield 3rd Place Play-Off",
  "Shield Final",
  "Shield Semi Final",
  "Super League Final",
  "Trophy 3rd Place Play-Off",
  "Trophy Final",
]);

// Name normalization (backlog #5): the Stage picker now shows CANONICAL stage
// labels, so the vetted RAW knockout set above is projected into canonical space
// ONCE here (each raw value mapped through canonicalStage, deduped). Every merged
// spelling is itself knockout, so this only SHRINKS the set (e.g. "Semi Final" /
// "Semi-Final" / "Semi-final" → the one canonical "Semi-Final") — no stage
// changes classification. The "Knockout games" button matches canonical options
// against THIS set.
const KNOCKOUT_STAGES_CANON = new Set([...KNOCKOUT_STAGES].map(canonicalStage));

/** A CANONICAL stage label counts as "knockout" for the shortcut iff it is in
 * the vetted knockout set (projected into canonical space). */
function isKnockoutStage(stage) {
  return KNOCKOUT_STAGES_CANON.has(stage);
}

/** Mount the Stage picker (state.stage). `embedded` suppresses the outer label.
 * The picker itself is the SHARED "All + specifics" component (mountAllMultiSelect,
 * as Result uses); this wrapper owns the async option vocabulary — loading the
 * in-scope stages, cross-filtering them by the selected Event(s), deciding whether
 * "No Stage" applies, and hiding the control when there is nothing to choose.
 * Returns `{ sync }`. */
export function mountStage(container, store, onChange, { embedded = false } = {}) {
  let namedOptions = null; // canonical stage labels in scope; null until loaded
  let hasNoStage = false; // does the scope contain matches with NO round name?
  let loadedScope = null; // scope key of the last successful load
  let loadingScope = null; // scope key of the load currently in flight
  let loadToken = 0;

  // FIX C: the Stage options are scoped to the FULL Search Conditions (gender +
  // format + date + team-type), not gender alone — so a Test scope no longer
  // lists T20-only rounds. Polish item 3 added the selected EVENT(s); the
  // cascading pass generalises that to EVERY sibling match filter (event +
  // seasons, venue, team, opposition, result condition, toss decision) via the
  // shared optionCacheKey, self-excluding "stage" so the list never collapses to
  // the stage already picked.
  const scopeKey = () => optionCacheKey(store.get(), ["stage"]);

  // The specifics offered to the shared picker: the in-scope named stages, plus
  // the "No Stage" sentinel when the scope actually holds unnamed-round matches.
  // Read fresh on every render (the component takes a function), so an async load
  // landing later is picked up without remounting.
  const optionList = () => {
    const named = (namedOptions || []).map((s) => ({ value: s, label: s }));
    return hasNoStage ? [...named, { value: STAGE_NONE, label: STAGE_NONE_LABEL }] : named;
  };

  // Nothing to choose: not loaded yet, or the total SELECTABLE option count is
  // ≤1 (polish item 3 / owner correction). "No Stage" is a real option in its
  // own right — a scope with one named stage PLUS unlabelled matches has TWO
  // choices (that named stage vs. no stage) and the dropdown must render. Only
  // hide when there is truly nothing to contrast (0 named + no No-Stage, or
  // exactly 1 named + no No-Stage, or 0 named + No-Stage alone with no named
  // stage to set it against).
  const totalOptions = () => (namedOptions ? namedOptions.length + (hasNoStage ? 1 : 0) : 0);
  const nothingToChoose = () => !namedOptions || totalOptions() <= 1;
  /** Does state.stage carry a real pick (anything other than the All sentinel)? */
  const hasStagePick = () => (store.get().stage || []).some((v) => v !== STAGE_ALL);

  const picker = mountAllMultiSelect(container, store, onChange, {
    field: "stage",
    allValue: STAGE_ALL,
    options: optionList,
    allLabel: "All stages",
    label: "Stage",
    embedded,
    // The knockout shortcut selects every in-scope KNOCKOUT stage (see
    // isKnockoutStage) and nothing else — never "All", never "No Stage" (a league
    // fixture with no round name is by definition not a knockout). If the list
    // hasn't loaded, or holds no knockout round, it snaps back to "All" rather
    // than leaving an empty selection.
    quick: {
      label: "Knockout games",
      onClick: ({ setValues }) => setValues((namedOptions || []).filter(isKnockoutStage)),
    },
    // Hide only when there is genuinely nothing to SHOW: nothing to choose AND
    // no pick of our own on screen. The ≤1-option hide rule is about not
    // offering a one-item list; it must never swallow a control that is
    // actively filtering (a surviving pick, or a dead one the user still has to
    // be able to un-tick). While the vocabulary is still loading, keep the old
    // hide behaviour so a slow load doesn't flash an empty dropdown.
    hiddenWhen: () => nothingToChoose() && (!namedOptions || !hasStagePick()),
    hiddenNote: "No tournament stages to choose in this scope.",
    optionsReady: () => namedOptions !== null,
  });

  async function ensureLoaded() {
    const key = scopeKey();
    // Guard on the KEY (not a bare boolean): a second sender can change while a
    // load is in flight, and a plain flag would swallow the reload.
    if (loadedScope === key || loadingScope === key) return;
    loadingScope = key;
    const token = ++loadToken;
    const s = store.get();
    let res;
    try {
      // Scoped to gender/format/date/team-type via searchStages (FIX C) — the
      // SAME matchOptionScope the Event/Venue pickers use — and cross-filtered by
      // every OTHER picked match filter (`sel`), with "stage" self-excluded.
      res = await searchStages(s.gender, s.teamType, s.formats, s.dateFrom, s.dateTo, { sel: s });
    } catch (e) {
      if (loadingScope === key) loadingScope = null;
      namedOptions = null; // retry on a later sync (e.g. pre-column data)
      picker.sync();
      return;
    }
    if (token !== loadToken) return; // a newer load superseded this one
    // Fold raw spellings to canonical labels (name normalization) and dedup, so
    // e.g. the three "Semi(-)Final" spellings collapse to one option; the checkbox
    // value stored in state.stage is the canonical label, which filters.js expands
    // back to every raw spelling. Sorted A–Z on the label.
    namedOptions = [...new Set(res.stages.map((r) => canonicalStage(r)))].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    hasNoStage = Boolean(res.hasNoStage);
    loadedScope = key;
    loadingScope = null;
    // Same currency guard as the other lists: only reconcile against a vocabulary
    // that still matches the live state (see mountScopedMultiSelect's ensureLoaded).
    if (key === scopeKey()) reconcileSelection();
    picker.sync();
  }

  /** Keep state.stage honest against the vocabulary NOW in scope, via the SHARED
   * all-or-nothing reconcilePicks() above: while at least one picked stage still
   * exists here the selection is left alone (a pick that has gone dead is shown
   * as a muted row rather than deleted); when none survives it snaps back to
   * "All". Only writes when something actually changed, so it converges.
   *
   * Stage's own additions are its two sentinels: STAGE_ALL is vocabulary-less
   * (kept, but never a survivor) and it is also this filter's inactive shape.
   * `allowed` is the real option list — NOT gated on nothingToChoose() any more:
   * a one-option list still contains its option, so a pick that matches it must
   * survive (the control stays visible for it, see hiddenWhen above). */
  function reconcileSelection() {
    if (!namedOptions) return; // never reconcile against a vocabulary we don't have
    const allowed = new Set(optionList().map((o) => o.value));
    const next = reconcilePicks(store.get().stage || [], allowed, {
      sentinels: [STAGE_ALL],
      inactive: [STAGE_ALL],
    });
    if (next) store.set({ stage: next });
  }

  function sync() {
    // (Re)load when ANY scope dimension — or the event selection — changed since
    // the last load, or on first visible; render now with whatever is cached.
    if (loadedScope !== scopeKey()) {
      namedOptions = null;
      hasNoStage = false;
      ensureLoaded();
    }
    picker.sync();
  }

  sync();
  return { sync };
}

// Game-count meta label (ROUND 3, task 4): "1,013 games" — localized thousands
// separator, the word "games" spelled out. Shown on Team/Event/Venue rows.
// (Opposition passes showGames:false — it keeps its own plain list, no meta.)
function gamesMeta(o) {
  return o && o.games != null ? `${Number(o.games).toLocaleString()} games` : "";
}

/**
 * Shared searchable MULTI-select for Team / Opposition / Event / Venue (Design
 * Round 2, wave R2-2b-ii). Wraps searchSelect.js's mountSearchMultiSelect
 * (portal:true so its panel escapes the Filters popup's overflow clip) and feeds
 * it the async, relevance-ranked option lists from playerData.js (searchTeams/
 * searchEvents/searchVenues) via `config.loader`. A9 (decision 47e): the loader
 * now scopes those lists to the FULL Search Conditions (gender + format + date +
 * team type — see each caller below). The picker still writes the SAME state
 * field it always did, so the built query — and every leaderboard/graph number —
 * is unchanged; A9 changes only which OPTIONS are offered.
 *
 * `config`:
 *   { get(state)->string[], set(store,arr), loader(gender,teamType)->Promise<rows>,
 *     emptyLabel, singular, plural, ariaLabel, searchPlaceholder,
 *     showGames?:bool, siblingExclude?:string[], onReconciled?():void,
 *     disabledWhen?(state)->bool, disabledNote?:string }
 * (the loader closes over `store` to read the format/date scope AND to pass the
 * live selection through as the cascading `sel`; the wrapper still calls it with
 * gender + team type. `siblingExclude` names this picker's OWN filter so the cache
 * key ignores it, matching the self-exclusion the loader applies in SQL.)
 *
 * Options load lazily — on the row becoming visible OR first toggle interaction
 * — and reload when ANY scope dimension changes (gender, team type, format, or
 * date) OR any sibling selection this list cross-filters by (see cacheKey).
 * filters.js clears the selection on a gender OR team-type change, so a stale
 * pick never survives those; a format/date/sibling change reloads the list but
 * does NOT clear the selection (see the final report's CONCERNS).
 * Returns `{ sync }`. */
function mountScopedMultiSelect(container, store, onChange, config) {
  container.innerHTML = `
    <div class="filter-group filter-group--ms" data-role="ms-group">
      <div data-role="ms-host"></div>
      ${config.disabledNote ? `<span class="profile-note" data-role="ms-note" hidden>${escHtml(config.disabledNote)}</span>` : ""}
    </div>`;
  const groupEl = container.querySelector('[data-role="ms-group"]');
  const hostEl = container.querySelector('[data-role="ms-host"]');
  const noteEl = container.querySelector('[data-role="ms-note"]');

  // Toggle label: 0 → placeholder; 1 → the single value's own name (getValues()
  // is up to date when summarize runs during a toggle/setValues); >1 → "N teams".
  let handle;
  const summarize = (count) => {
    const vals = handle ? handle.getValues() : [];
    if (vals.length === 1) return vals[0];
    return `${count} ${count === 1 ? config.singular : config.plural}`;
  };

  handle = mountSearchMultiSelect(hostEl, {
    options: [],
    values: config.get(store.get()),
    portal: true,
    placeholder: config.emptyLabel,
    filterPlaceholder: config.searchPlaceholder,
    summarize,
    ariaLabel: config.ariaLabel,
    // A pick the all-or-nothing reconcile keeps alive can be absent from the
    // narrowed option list. It must stay VISIBLE and un-tickable rather than
    // disappear from its own dropdown while still filtering the table.
    keepMissingSelected: true,
    missingNote: DEAD_PICK_NOTE,
    renderRow: (o) => {
      const meta = config.showGames ? gamesMeta(o) : "";
      return (
        `<span class="search-select__check" aria-hidden="true"></span>` +
        `<span class="search-select__opt-label">${escHtml(o.label)}</span>` +
        (meta ? `<span class="search-select__meta">${escHtml(meta)}</span>` : "")
      );
    },
    onChange: (values) => {
      config.set(store, values); // SAME state field as before → query unchanged
      onChange();
    },
  });

  const toggleEl = hostEl.querySelector(".search-select__toggle");

  // ── Async option loading (full-scope: gender|teamType|format|date, lazy) ────
  // A9 (decision 47e): the option lists scope to the FULL Search Conditions, so
  // the cache key carries every scope dimension — a change to gender, team type,
  // format, OR date invalidates the cache and reloads the list for the new scope
  // (sync() below diffs loadedKey against this on every store change while the
  // popup is open, which is how a format/date edit live-refreshes the list).
  // CASCADING: the key ALSO carries every sibling selection that narrows this
  // list (config.siblingExclude names this picker's own filter, which must not
  // narrow it) — so picking an Event immediately reloads the Venue list, etc.
  let optionsCache = [];
  let loadedKey = null;
  let loadToken = 0;
  let loadingKey = null;
  const cacheKey = () => optionCacheKey(store.get(), config.siblingExclude || []);
  async function ensureLoaded() {
    const key = cacheKey();
    // Guard on the KEY, not a bare boolean: with cascading, a second sender can
    // change while a load is still in flight, and a plain `loading` flag would
    // swallow the reload and leave stale options. The loadToken below discards
    // the superseded response.
    if (loadedKey === key || loadingKey === key) return;
    loadingKey = key;
    const token = ++loadToken;
    const s = store.get();
    let rows;
    try {
      rows = await config.loader(s.gender, s.teamType);
    } catch (e) {
      if (loadingKey === key) loadingKey = null;
      return; // leave options empty; a later open retries
    }
    if (token !== loadToken) return;
    loadingKey = null;
    optionsCache = rows || [];
    loadedKey = key;
    handle.setOptions(optionsCache);
    // Drop any pick this scope + sibling combination can no longer satisfy, BEFORE
    // reflecting the selection below, so the toggle shows the reconciled truth.
    // ONLY against a list that still describes the CURRENT state: another picker's
    // own reconcile can land between this load being issued and its reply, and
    // reconciling a selection against options loaded for a superseded state could
    // drop a pick that is valid again. When that happens sync() reloads for the new
    // key (loadedKey then differs from cacheKey) and reconciles from THAT reply.
    if (key === cacheKey()) reconcileSelection();
    // Reflect the current selection against the fresh options (keeps the toggle
    // summary + checks honest; setOptions on its own would drop unknown values).
    handle.setValues(config.get(store.get()));
  }

  /** Keep this picker's selection honest against the vocabulary NOW available —
   * the same rule mountStage applies to state.stage, via the shared
   * all-or-nothing reconcilePicks() (see its header for why keeping a dead pick
   * cannot move a number, and why the reconcile → reload cycle converges). While
   * ANY picked value is still offered the selection is left exactly as it is;
   * the ones that are currently impossible show up as muted rows in the dropdown
   * (keepMissingSelected above). Runs ONLY after a successful load, so a failed
   * query never wipes a selection. This filter's inactive shape is the EMPTY
   * ARRAY (no narrowing) — there is no "All" sentinel on this side. A reconcile
   * that empties the selection therefore leaves exactly the state a user gets by
   * clearing the filter by hand. */
  function reconcileSelection() {
    const next = reconcilePicks(config.get(store.get()), new Set(optionsCache.map((o) => o.value)), { inactive: [] });
    if (!next) return;
    config.set(store, next); // SAME state field the picker itself writes
    // Callers with dependent state (mountEvent's per-event season narrowing) get
    // the same follow-up they run after a user edit, so a reconciled-away value
    // can't leave orphan state behind.
    if (config.onReconciled) config.onReconciled();
  }

  // Lazy-load fallback: first interaction with the toggle (before it opens).
  toggleEl.addEventListener("mousedown", ensureLoaded);
  toggleEl.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " " || e.key === "Spacebar") ensureLoaded();
  });

  function sync() {
    const s = store.get();
    // Generic disabled-state affordance (config.disabledWhen/disabledNote): grey
    // the toggle (:disabled styling) + show a note when a caller opts in. No
    // current caller does (Opposition's international-only gate was removed by
    // decision 51 / R5-F #14) — kept as shared infrastructure for any future
    // scope-gated picker.
    const disabled = config.disabledWhen ? config.disabledWhen(s) : false;
    if (noteEl) noteEl.hidden = !disabled;
    groupEl.classList.toggle("is-disabled", disabled);
    toggleEl.disabled = disabled;
    if (disabled) handle.close();

    if (loadedKey !== null && loadedKey !== cacheKey()) {
      // Any scope dimension changed since the last load (gender/team-type/format/
      // date — see cacheKey) — drop the cache and reload the OPTION list for the
      // new scope. ensureLoaded() re-applies the selection against the fresh
      // options (setOptions + setValues) when it resolves.
      loadedKey = null;
      ensureLoaded();
    } else if (loadedKey === null && hostEl.offsetParent !== null) {
      // Row is visible (popup open, condition present) and nothing loaded yet —
      // pre-load so the first open shows a populated list, not a flash of empty.
      ensureLoaded();
    }
    // R5-A #15: ALWAYS force the toggle summary + (if open) the option list to
    // re-render against the CURRENT selection now — never deferred to the async
    // reload above. Previously this ran ONLY in the scope-unchanged branch, so a
    // cleared/changed selection (Clear-all, a pill ×, or a scope change) left the
    // stale team/event/venue name lingering on the toggle until the row was
    // clicked or the async load landed. The state was always correct; only the
    // display lagged. setValues filters against the loaded options and never fires
    // onChange, so this is a cheap, safe idempotent refresh.
    handle.setValues(config.get(s));
  }

  sync();
  return { sync };
}

/** "Played for" — single gender + team-type-scoped team picker (state.teams).
 * Cascading: narrowed by every other picked match filter INCLUDING Opposition
 * (so with Opposition = Australia this lists the teams that actually played
 * Australia), but never by state.teams itself — hence role: "teams". */
export function mountTeam(container, store, onChange) {
  return mountScopedMultiSelect(container, store, onChange, {
    get: (s) => s.teams || [],
    set: (st, arr) => st.set({ teams: arr }),
    siblingExclude: ["teams"],
    loader: (gender, teamType) => {
      const s = store.get(); // A9: scope the Team list to the full Search Conditions
      return searchTeams("", gender, teamType, s.formats, s.dateFrom, s.dateTo, { sel: s, role: "teams" });
    },
    emptyLabel: "All teams",
    singular: "team",
    plural: "teams",
    ariaLabel: "Played for team",
    searchPlaceholder: "Search teams…",
    showGames: true,
  });
}

// ── Event → Season nested picker (Wave 6 pt2; multi-check DROPDOWN, item 2) ───
// mountEvent gains a nested season sub-picker rendered directly BELOW the event
// multi-select, as an indented child row. Each SELECTED event gets its own
// multi-check DROPDOWN — the same portal-dropdown mechanics as the Format /
// Team-type dropdowns in the scope strip (polish item 2 replaced the former inline
// checkbox rows, which sprawled once an event had many seasons). Inside: an "All
// seasons" box plus one box per in-scope season (season_year_start DESC).
//
// "All" checked ⟺ NO narrowing (state.eventSeasons carries no key for that event)
// — so an event on All filters exactly as it did before this picker existed
// (backward-compatible; the query is byte-identical, see filters.js).
//
// "All seasons" is a REAL TOGGLE (owner ruling, polish item 2): checking it
// selects every season, UNCHECKING it clears every season. It is never disabled or
// greyed. That means an empty selection is reachable, and it means exactly what
// the owner ruled it means — Empty = All = NO narrowing. It is stored as an EMPTY
// ARRAY (as against the absent key that means All), purely so the picker can show
// "nothing ticked" faithfully; both shapes emit the identical event-only clause
// (filters.js only narrows on a non-empty season list, and anyEventSeasonNarrowing
// only counts non-empty ones), so neither can move a number. The former min-one
// guards (All disabled while checked; sole season undeselectable) are gone with it.
//
// An event with ≤1 in-scope season renders NO dropdown at all (owner ruling): a
// one-option list is nothing to choose from. The one exception — required by the
// all-or-nothing reconcile — is an event that IS narrowed right now: its
// dropdown stays on screen (showing the surviving and the dead picks) so the
// narrowing can be seen and undone, because hiding a control that is actively
// filtering would be the invisible-filter problem the ≤1 rule exists to avoid.
// If no selected event has more than one season and none is narrowed, the whole
// child row is hidden.
//
// Season OPTIONS come from searchEventSeasons, scoped to the SAME full Search
// Conditions as the event list (gender/format/date/team-type), cached, and
// reloaded when that scope OR the selected-event set changes. NB: a change to
// gender/format/team-type/date CLEARS state.event (owner decision 2026-07-18, in
// filters.js) and — with it — state.eventSeasons, so in practice the season list
// is re-derived by RE-PICKING the event under the new window. See the report's
// CONCERNS for the interaction with that standing decision.
function mountEventSeasons(container, store, onChange) {
  let optionsByEvent = {}; // { [event_name]: [{ event, season, syr, games }] } for loadedKey
  let loadedKey = null;
  let loadToken = 0;
  let loadingKey = null;
  // One persistent dropdown per event label, created lazily and REUSED. The nodes
  // must outlive a render: wirePortalDropdown registers document-level listeners
  // and remembers the panel's home slot, so rebuilding the markup each render
  // would both leak listeners and strand the portal. Rendering therefore only
  // re-fills each group's list + toggle and re-appends the existing element.
  const groupCache = new Map(); // event -> { el, toggle, list, dropdown }

  // Cache key: the full Search-Conditions scope, the selected-event set (this
  // loader's own axis — a change to it reloads the per-event season lists), AND
  // every sibling match filter that cross-filters the seasons offered (venue,
  // stage, team, opposition, result condition, toss decision). "event" and
  // "eventSeasons" are self-excluded from the sibling half: the event set is
  // already carried explicitly here, and the season narrowing must never narrow
  // the season list itself.
  const dataKey = () =>
    `${optionCacheKey(store.get(), ["event", "eventSeasons"])}||${[...(store.get().event || [])].sort().join("~")}`;

  const inScopeSeasons = (eventName) => (optionsByEvent[eventName] || []).map((r) => r.season);
  const getES = () => store.get().eventSeasons || {};
  /** Is this event actually narrowed to specific seasons right now? ([] is the
   * owner's empty selection — honest, but no narrowing.) */
  const hasNarrowing = (eventName) => {
    const cur = getES()[eventName];
    return Array.isArray(cur) && cur.length > 0;
  };
  /** Picked seasons this event no longer offers — kept by the all-or-nothing
   * reconcile, so they must stay visible (and un-tickable) in the dropdown. */
  const deadSeasons = (eventName) => {
    const cur = getES()[eventName];
    if (!Array.isArray(cur)) return [];
    const inScope = new Set(inScopeSeasons(eventName));
    return cur.filter((sn) => !inScope.has(sn));
  };
  /** The selected events that get a dropdown: those with MORE THAN ONE in-scope
   * season (owner ruling — one option is nothing to choose), PLUS any event that
   * is actually narrowed, whose narrowing has to stay on screen to be undoable
   * (never hide a control that is filtering). */
  const visibleEvents = () =>
    (store.get().event || []).filter((e) => inScopeSeasons(e).length > 1 || hasNarrowing(e));

  /** Write the season narrowing for one event.
   *   null            → "All seasons" (removes the key → no narrowing).
   *   the FULL in-scope set → also collapses to All, so re-checking the last
   *                     season snaps back rather than emitting a redundant
   *                     `season IN (every season)`.
   *   []              → the owner's empty selection: stored as an empty array so
   *                     the picker can show nothing ticked; still NO narrowing.
   *   a proper subset → the narrowing itself. */
  function setEventSeasons(eventName, seasons) {
    const es = { ...getES() };
    const all = inScopeSeasons(eventName);
    // "Covers every in-scope season" collapses to All — but only when the
    // selection is NOTHING BUT in-scope seasons. A dead pick in there means the
    // selection is genuinely narrower than "all seasons", and collapsing would
    // silently delete it.
    const isFull =
      seasons &&
      seasons.length > 0 &&
      all.length > 0 &&
      all.every((sn) => seasons.includes(sn)) &&
      seasons.every((sn) => all.includes(sn));
    if (seasons === null || isFull) delete es[eventName];
    else es[eventName] = seasons;
    store.set({ eventSeasons: es });
  }

  async function ensureLoaded() {
    const events = store.get().event || [];
    const key = dataKey();
    if (events.length === 0) {
      optionsByEvent = {};
      loadedKey = key;
      return;
    }
    // Guard on the KEY (not a bare boolean): with cascading a second sender can
    // change while a load is in flight, and a plain flag would swallow the reload.
    if (loadedKey === key || loadingKey === key) return;
    loadingKey = key;
    const token = ++loadToken;
    const s = store.get();
    let rows;
    try {
      rows = await searchEventSeasons(events, s.gender, s.teamType, s.formats, s.dateFrom, s.dateTo, { sel: s });
    } catch (e) {
      if (loadingKey === key) loadingKey = null;
      return; // leave options empty; a later sync retries (e.g. pre-column data)
    }
    if (token !== loadToken) return;
    loadingKey = null;
    const grouped = {};
    for (const r of rows) (grouped[r.event] = grouped[r.event] || []).push(r);
    optionsByEvent = grouped;
    loadedKey = key;
    // Keep any narrowing honest against the freshly-loaded seasons — but only when
    // this reply still describes the live state (same currency guard as the other
    // lists; sync() reloads and reconciles again otherwise).
    if (key === dataKey()) reconcileNarrowing();
    render();
  }

  /** After a fresh load (scope, event selection, OR any sibling filter changed —
   * dataKey carries all three), reconcile each event's season narrowing against
   * the seasons NOW in scope, to the SAME all-or-nothing standard the other
   * pickers use (see the reconcilePicks header), applied PER EVENT:
   *
   *   ≥1 picked season still in scope → leave that event's narrowing exactly as
   *     it is. Seasons that have gone out of scope are kept and rendered as
   *     muted rows (deadSeasons above) — they are dead disjuncts in the
   *     `season IN (…)` list, so keeping them cannot move a number, and keeping
   *     them is what makes the picker order-independent (widen the other filters
   *     again and the season comes back to life, rather than being gone).
   *   none survives → drop the key for THAT event only, back to "All seasons",
   *     so results widen instead of stranding a zero-row filter. This is what
   *     keeps the picker honest when the date window shrinks while an event
   *     stays selected (e.g. narrowed to 2024, then a TOOLBAR date change to a
   *     2026-only window — the toolbar date, unlike the popup date, does NOT
   *     clear the event).
   *
   * An event whose seasons collapse to ≤1 no longer has its narrowing deleted:
   * visibleEvents() keeps a narrowed event's dropdown on screen, so there is no
   * invisible filter to guard against. Only writes when something changed, so it
   * converges (no store-churn loop). */
  function reconcileNarrowing() {
    const es = getES();
    const events = store.get().event || [];
    const next = { ...es };
    let changed = false;
    for (const e of events) {
      const cur = es[e];
      if (!Array.isArray(cur)) continue; // already "All"
      if (cur.length === 0) continue; // the owner's empty selection — honest, no narrowing
      const inScope = new Set(inScopeSeasons(e));
      if (cur.some((sn) => inScope.has(sn))) continue; // ≥1 survivor → keep the LOT
      delete next[e];
      changed = true;
    }
    if (changed) store.set({ eventSeasons: next });
  }

  /** Toggle summary for one event's season dropdown. Reads out what is ACTUALLY
   * applied (§8.4 honesty): both "All" and the empty selection filter to every
   * season, so both read "All seasons". */
  function summaryLabel(eventName) {
    const cur = getES()[eventName];
    if (!Array.isArray(cur) || cur.length === 0) return "All seasons";
    if (cur.length === 1) return cur[0];
    return `${cur.length} seasons`;
  }

  /** Create (once) the persistent DOM + portal wiring for one event's dropdown.
   * The change handler is delegated on the PANEL, not the outer container: while
   * open, wirePortalDropdown moves the panel to <body>, so events inside it never
   * reach the container. */
  function ensureGroup(eventName) {
    const cached = groupCache.get(eventName);
    if (cached) return cached;
    const el = document.createElement("div");
    el.className = "event-seasons__group";
    el.setAttribute("data-event", eventName);
    el.innerHTML = `
      <div class="event-seasons__name" data-role="es-name" hidden></div>
      <div class="dropdown" data-role="es-dropdown">
        <button type="button" class="select dropdown__toggle" data-role="es-toggle" aria-haspopup="true" aria-expanded="false">All seasons</button>
        <div class="dropdown__panel" data-role="es-panel" hidden>
          <div class="dropdown__list" data-role="es-list"></div>
        </div>
      </div>`;
    const g = {
      el,
      name: el.querySelector('[data-role="es-name"]'),
      toggle: el.querySelector('[data-role="es-toggle"]'),
      panel: el.querySelector('[data-role="es-panel"]'),
      list: el.querySelector('[data-role="es-list"]'),
    };
    g.dropdown = wirePortalDropdown(g.toggle, g.panel);
    g.panel.addEventListener("change", (ev) => {
      const input = ev.target;
      if (!(input instanceof HTMLInputElement)) return;
      const all = inScopeSeasons(eventName);
      if (input.hasAttribute("data-all")) {
        // A REAL toggle (owner ruling): checked → every season; unchecked → none.
        setEventSeasons(eventName, input.checked ? null : []);
      } else if (input.hasAttribute("data-season")) {
        const sn = input.getAttribute("data-season");
        const curES = getES()[eventName];
        // On "All" the effective starting set is EVERY in-scope season; on the
        // empty selection it is nothing.
        const base = Array.isArray(curES) ? curES.slice() : all.slice();
        let next = input.checked ? (base.includes(sn) ? base : [...base, sn]) : base.filter((x) => x !== sn);
        // Keep the season order stable: dead picks first (that is where they are
        // rendered, and ordering by the in-scope list alone would silently drop
        // them on any unrelated tick), then in-scope order = season_year_start desc.
        const order = [...deadSeasons(eventName), ...all];
        next = order.filter((x) => next.includes(x));
        setEventSeasons(eventName, next);
      } else {
        return;
      }
      renderGroup(eventName);
      onChange();
    });
    groupCache.set(eventName, g);
    return g;
  }

  /** Re-fill one event's dropdown (toggle summary + checkbox list) from state. */
  function renderGroup(eventName, showName) {
    const g = ensureGroup(eventName);
    if (showName !== undefined) {
      g.name.textContent = eventName;
      g.name.hidden = !showName;
    }
    g.toggle.textContent = summaryLabel(eventName);
    const all = inScopeSeasons(eventName);
    const cur = getES()[eventName];
    const onAll = !Array.isArray(cur);
    const sel = new Set(onAll ? all : cur);
    // Neither box is ever disabled: "All seasons" toggles select-all/clear-all,
    // and any season can be unchecked (clearing the last one just lands on the
    // empty selection, which filters to everything).
    const allBox = `<label class="dropdown__item">
      <input type="checkbox" data-all ${onAll ? "checked" : ""} />
      <span>All seasons</span>
    </label>`;
    // Picked seasons this event no longer has in scope: ticked, muted,
    // annotated — clickable, so un-ticking one removes it for good.
    const deadBoxes = deadSeasons(eventName)
      .map(
        (sn) => `<label class="dropdown__item dropdown__item--dead">
          <input type="checkbox" data-season="${escAttr(sn)}" checked />
          <span>${escHtml(sn)}</span>
          <span class="dropdown__item-note">${escHtml(DEAD_PICK_NOTE)}</span>
        </label>`
      )
      .join("");
    const seasonBoxes = all
      .map(
        (sn) => `<label class="dropdown__item">
          <input type="checkbox" data-season="${escAttr(sn)}" ${sel.has(sn) ? "checked" : ""} />
          <span>${escHtml(sn)}</span>
        </label>`
      )
      .join("");
    g.list.innerHTML = allBox + deadBoxes + seasonBoxes;
  }

  function render() {
    const events = store.get().event || [];
    if (events.length === 0) {
      container.hidden = true;
      container.textContent = "";
      return;
    }
    // Options for the current scope+selection not loaded yet → a light note;
    // ensureLoaded() (kicked from sync) re-renders when it lands.
    if (loadedKey !== dataKey()) {
      container.hidden = false;
      container.innerHTML = `<p class="event-seasons__loading profile-note">Loading seasons…</p>`;
      return;
    }
    const visible = visibleEvents();
    if (visible.length === 0) {
      // Every selected event has ≤1 season in scope — nothing to choose anywhere.
      container.hidden = true;
      container.textContent = "";
      return;
    }
    container.hidden = false;
    container.innerHTML = `<div class="event-seasons__head">Season</div>`;
    for (const e of visible) {
      // With ONE event the parent's own toggle already names it, so the per-event
      // caption would just repeat it; with several, each dropdown needs its name.
      renderGroup(e, visible.length > 1);
      container.appendChild(groupCache.get(e).el);
    }
  }

  function sync() {
    // (Re)load when the scope OR selection changed since the last load; render
    // now with whatever is cached (render shows a loading note while stale).
    if (loadedKey !== dataKey()) ensureLoaded();
    render();
  }

  sync();
  return { sync };
}

/** "Event" — gender + team-type-scoped competition/series picker (state.event),
 * extended (Wave 6 pt2) with a nested season sub-picker below it. */
export function mountEvent(container, store, onChange) {
  container.innerHTML = `
    <div class="filter-group filter-group--event" data-role="event-wrap">
      <div data-role="event-ms"></div>
      <div class="event-seasons" data-role="event-seasons" hidden></div>
    </div>`;
  const msHost = container.querySelector('[data-role="event-ms"]');
  const seasonsHost = container.querySelector('[data-role="event-seasons"]');

  const seasons = mountEventSeasons(seasonsHost, store, onChange);

  /** Drop eventSeasons narrowing for events no longer selected — so a
   * de-selected + re-selected event returns on "All" and the state keeps no
   * orphan keys. Only writes when something changed (no store-churn loop). */
  function pruneOrphans() {
    const selected = new Set(store.get().event || []);
    const es = store.get().eventSeasons || {};
    let changed = false;
    const next = {};
    for (const k of Object.keys(es)) {
      if (selected.has(k)) next[k] = es[k];
      else changed = true;
    }
    if (changed) store.set({ eventSeasons: next });
  }

  const msController = mountScopedMultiSelect(
    msHost,
    store,
    () => {
      // The event selection just changed (config.set already wrote state.event):
      // drop orphan season narrowing, refresh the season groups, then propagate.
      pruneOrphans();
      seasons.sync();
      onChange();
    },
    {
      get: (s) => s.event || [],
      set: (st, arr) => st.set({ event: arr }),
      // Cascading: narrowed by venue/stage/team/opposition/result-condition/toss
      // decision, but NEVER by the event selection itself (self-exclusion — the
      // list must stay the full in-scope vocabulary while one event is picked).
      siblingExclude: ["event"],
      // A reconcile that drops an impossible event must clean up after itself
      // exactly like a hand de-select does: drop that event's orphan season
      // narrowing, then re-render the season groups.
      onReconciled: () => {
        pruneOrphans();
        seasons.sync();
      },
      loader: (gender, teamType) => {
        const s = store.get(); // A9: scope the Event list to the full Search Conditions
        return searchEvents("", gender, teamType, s.formats, s.dateFrom, s.dateTo, { sel: s });
      },
      emptyLabel: "Any event",
      singular: "event",
      plural: "events",
      ariaLabel: "Event",
      searchPlaceholder: "Search events…",
      showGames: true,
    }
  );

  return {
    sync() {
      msController.sync();
      seasons.sync();
    },
  };
}

/** "Venue" — gender + team-type-scoped ground picker (state.venue). Cascading:
 * with Event = County Championship this lists ONLY county grounds; never narrowed
 * by state.venue itself (self-exclusion). */
export function mountVenue(container, store, onChange) {
  return mountScopedMultiSelect(container, store, onChange, {
    get: (s) => s.venue || [],
    set: (st, arr) => st.set({ venue: arr }),
    siblingExclude: ["venue"],
    loader: (gender, teamType) => {
      const s = store.get(); // A9: scope the Venue list to the full Search Conditions
      return searchVenues("", gender, teamType, s.formats, s.dateFrom, s.dateTo, { sel: s });
    },
    emptyLabel: "Any venue",
    singular: "venue",
    plural: "venues",
    ariaLabel: "Venue",
    searchPlaceholder: "Search venues…",
    showGames: true,
  });
}

/**
 * "Against opposition" — team picker over state.opposition. The option list is
 * the EXACT SAME mechanism as the "Played for" Team picker (searchTeams, now
 * scoped to the full Search Conditions per A9 / decision 47e, games-desc — R7
 * owner correction, item 5), so the big cricketing nations lead. Used to be
 * International-only (decision 20); decision 51 (R5-F #14) enables it for
 * club/domestic too, on the same raw (un-normalized) team names — so the
 * control is always usable and never greys out. No games meta (its historic
 * plain list). The `embedded` arg is accepted for call-site parity (the row's
 * type label already names it) but unused — the wrapper never renders its own
 * label.
 */
export function mountOpposition(container, store, onChange, { embedded = false } = {}) {
  void embedded;
  return mountScopedMultiSelect(container, store, onChange, {
    get: (s) => s.opposition || [],
    set: (st, arr) => st.set({ opposition: arr }),
    // Cascading: narrowed by "Played for" (with Team = India this lists exactly
    // the teams India faced) but never by state.opposition itself — role:
    // "opposition" is what tells the shared loader which half is self.
    siblingExclude: ["opposition"],
    loader: (gender, teamType) => {
      const s = store.get(); // A9: scope the Opposition list to the full Search Conditions
      return searchTeams("", gender, teamType, s.formats, s.dateFrom, s.dateTo, { sel: s, role: "opposition" });
    },
    emptyLabel: "Any opposition",
    singular: "opponent",
    plural: "opponents",
    ariaLabel: "Against opposition",
    searchPlaceholder: "Search teams…",
    showGames: false,
  });
}
