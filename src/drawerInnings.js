// src/drawerInnings.js
//
// The individual filter-editor controls mounted into the condition builder's
// rows (src/drawer.js). Each is a self-contained `{ sync }` controller that
// renders/wires its own DOM and calls store.set(...); drawer.js mounts them
// once and just shows/hides their row by presence, so they survive the numeric
// builder's rebuilds (their option caches + portal wiring never get torn down).
//
//   mountBattingPosition  — "Batting position" filter (state.positions): the
//                           striker/own batting-position slice. Shows in PLAIN
//                           batting AND any matchup; self-hides in plain bowling
//                           (no batting_position column). Position rework 2026-08-14.
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
// removing a filter re-expands the others without touching what is already picked.
// A pick the current combination has made impossible is NEVER dropped either — it
// is kept and rendered greyed (owner ruling; see "A PICK IS NEVER REWRITTEN" below).
// The SQL half lives in ONE place (playerData.js siblingOptionClauses, over the
// shared predicate fragments in filters.js); the cache-key half is
// optionCacheKey() below, and both take the same self-exclusion list.
// Team/Event/Venue rows show a "<name>  N games" meta; Opposition keeps its plain
// list (no meta) and, since decision 51 (R5-F #14), is enabled for every team type.

import { wirePortalDropdown } from "./filters.js";
import {
  matchupVsActive,
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
  POTM_YN_OPTIONS,
  inningsNumberOptions,
  inningsNumberLabel,
} from "./state.js";
import { searchTeams, searchEvents, searchVenues, searchCities, searchSeasons, searchEventSeasons, searchStages } from "./playerData.js";
import { withDeliveryWindowPiece } from "./deliveryWindow.js";
import { canonicalStage } from "./canonicalNames.js";
import { query } from "./db.js";
import { mountSearchMultiSelect } from "./searchSelect.js";
import { mountOmnisearch } from "./omnisearch.js";
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

// ── Cascading option lists: A PICK IS NEVER REWRITTEN (owner ruling) ─────────
// Cross-filtered options are offered with OR-logic across your picks: with
// Venue = {Mission Road, Gelephu} the Stage list offers Final (Mission Road
// hosted Finals) AND Semi-Final (Gelephu did). So a pick can stop being
// available without the user touching it — pick Stage = Final and Gelephu, which
// hosted no Final, contributes nothing.
//
// THE RULE, as the owner has ruled it: the app NEVER changes the selection. Not
// value-by-value (an earlier pass), and not as a whole-selection reset back to
// "no narrowing" (the pass before this one). Silently discarding a choice — or
// silently WIDENING the results away from what the controls say — is the bug.
// Instead every currently-impossible value is KEPT and rendered greyed, ticked,
// annotated `no matches with your current filters`, and still clickable so it can
// be un-ticked. Each picker computes that "available" set for DISPLAY only:
// mountSearchMultiSelect's `keepMissingSelected` for Team/Opposition/Event/Venue,
// `deadSpecifics()` in mountAllMultiSelect for Stage, `deadSeasons()` in
// mountEventSeasons for Season. Unticked options that are merely irrelevant stay
// HIDDEN — nothing here re-expands a narrowed list.
//
// ACCEPTED CONSEQUENCE (owner): a selection whose values are ALL impossible now
// survives, so the leaderboard can legitimately come back with ZERO rows. That
// is correct — the greyed rows, the pills and the in-popup notice (drawer.js,
// fed by the deadReport() each picker exposes below) explain why. It is not a
// bug to be "fixed" by widening.
//
// THE INVISIBLE-PICK GUARANTEE: because a pick now lives forever until the user
// removes it, a control that HOLDS one must always be on screen — otherwise the
// pick would be both permanent and unreachable. So the two "nothing to choose
// here, hide the control" rules (Stage's ≤1-option rule, Season's one-season
// rule) both yield to a control that is actually filtering. See mountStage's
// `hiddenWhen` and mountEventSeasons' `visibleEvents`.
//
// NUMBERS (Rule 1): keeping a dead pick moves nothing by itself. A loader's list
// is the COMPLETE set of values available for the current scope + siblings (no
// LIMIT anywhere, and the search term only ever reorders — it never filters rows
// out), so a picked value absent from a freshly-loaded list cannot be satisfied
// by any match in scope: it is a dead disjunct in its own IN-list, and keeping it
// in — exactly like removing it — leaves the built query's result set untouched.
//
// CONVERGENCE is now trivial: no reconcile writes state at all, so the
// load → reconcile → reload cycle that had to be argued about no longer exists.
// An option list reloads only when the user changes something.

/** Shown on a picked value that the current filter combination has made
 * impossible. Kept in ONE place so every picker says the same thing. */
const DEAD_PICK_NOTE = "no matches with your current filters";

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

/** The batting-position control's discipline-dependent display NAME (decision 81B,
 * owner 2026-08-27). ONE control (state.positions → `batting_position IN`): on the
 * batting board it is the subject's OWN position → "Batting position"; on the bowling
 * board the SAME control filters the OPPONENT batter's position → "vs opponent batting
 * position" (a matchup axis). Display-only — the query is identical on both boards. */
export function battingPositionFilterLabel(discipline) {
  return discipline === "bowling" ? "vs opponent batting position" : "Batting position";
}

/**
 * Mount the "Batting position" multi-select (state.positions). `embedded`
 * suppresses the outer filter-label (the condition row already names it).
 * Shows in plain batting and any matchup; hidden in plain bowling. Returns `{ sync }`.
 */
export function mountBattingPosition(container, store, onChange, { embedded = false } = {}) {
  container.innerHTML = `
    <div class="filter-group filter-group--positions" data-role="positions-group">
      ${embedded ? "" : `<span class="filter-label" data-role="positions-label">Batting position</span>`}
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
    label: container.querySelector('[data-role="positions-label"]'),
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

  /** Position rework (2026-08-14): live in PLAIN batting (the batter's own
   * position) AND any matchup (matchup_batting = batter's own; matchup_bowling =
   * the striker faced). Hidden ONLY in plain bowling, whose view has no
   * batting_position column, so a stale value there is inert. */
  function sync() {
    const state = store.get();
    const matchupOn = matchupVsActive(state);
    const show = matchupOn || state.discipline === "batting";
    els.group.hidden = !show;
    if (!show) {
      dropdown.close();
      return;
    }
    els.toggle.disabled = false;
    // Discipline-dependent NAME (decision 81B): "Batting position" (batting) /
    // "vs opponent batting position" (bowling). Only the non-embedded mount carries
    // this label span; the leaderboard mounts embedded (the condition row names it).
    if (els.label) els.label.textContent = battingPositionFilterLabel(state.discipline);
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

// ── Fielding SLICE pickers (fielding rebuild) ───────────────────────────────
// A multi-select checkbox dropdown that narrows WHICH wicket-events the
// Catches/Stumpings/Run-outs/Dismissals-Effected metrics count, by the event's
// OWN dims — dismissed-batter position (state.fielding.positions). Same
// self-contained `{ sync }` shape and portal dropdown as mountBattingPosition
// above, so it slots into the condition builder's singleton rows the same way.
// PLAIN mode only: the fielding metrics live in the plain buildQuery (its
// fielding_cte join) — matchup Vs mode has no fielding, so this self-hides
// there (mirrors mountBattingPosition's matchup gate, inverted).
// (R6 cleanup: the sibling "Fielding phase" picker — state.fielding.phases at
// this top level — was removed here as dead code: it was never offered by the
// "+ Add condition" palette in paletteGroups.js, so its row could never appear.
// buildFieldingSliceClauses' phase handling in table.js stays — it is still
// exercised by the player pop-up's own, separate per-row fielding editor.)

/** Generic checkbox multi-select over one list on state.fielding. `field` is
 * currently always "positions"; `options` is [{value,label}] (value is the
 * literal written to state — a number for positions);
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

/** Fielding: dismissed-batter position slice (state.fielding.positions, 1–12). */
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
    label: "Dismissed batter's position",
    ...opts,
  });
}

// ── Match-context pickers (Wave 6) ──────────────────────────────────────────
// Four categorical filters keyed off the MATCH's context, available in batting,
// bowling AND matchup views (unlike the fielding slices, they have no matchup
// gate). Three sit in the "Match context" group of the "+ Add condition…" picker;
// Stage moved up into the "Match" group beside Event (polish item 3). Toss result /
// toss decision are fixed-vocabulary checkbox multi-selects over a
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
 * (result / tossResult / tossDecision). `options` is
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
  const dropdown = wirePortalDropdown(els.toggle, els.panel);

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
  return { sync, close: () => dropdown.close() };
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
// DEAD PICKS: a stored value can outlive its own option list (Stage =
// {Final, Semi-Final} while a venue narrows the list to Final alone) — and, per
// the owner's ruling, is never deleted for it. Such a value renders as a muted,
// still-un-tickable box at the top of the list rather than vanishing — see the
// "A PICK IS NEVER REWRITTEN" header. `optionsReady` lets an async picker (Stage)
// say "my vocabulary hasn't loaded yet", so a slow load doesn't paint every pick
// dead for a moment.
//
// PINNED SELECTION: ticked specifics render as a block directly under the dead
// picks, above the untouched rest of the list. Like the searchSelect widget's
// `pinSelected`, the block is a snapshot frozen while the dropdown is open (see
// pinnedSet below), so no box moves under the cursor as you tick.
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
  /** Is EVERY picked specific currently impossible? (feeds drawer.js's in-popup
   * "this will come back empty" notice; null while the vocabulary is unknown.) */
  const deadReport = (labelText) => {
    if (optionsReady && !optionsReady()) return null;
    const sp = specifics().map(String);
    if (sp.length === 0) return null;
    const dead = deadSpecifics();
    return dead.length === sp.length ? { label: labelText, values: dead } : null;
  };
  /** Ticked specifics pinned to the top of the list — a snapshot taken when the
   * dropdown opens (and when the vocabulary reloads), then frozen while it stays
   * open so ticking never reorders the boxes under the pointer. */
  let pinnedSnapshot = null;
  const invalidatePinned = () => {
    pinnedSnapshot = null;
  };
  const pinnedSet = () => {
    if (pinnedSnapshot === null) pinnedSnapshot = new Set(specifics().map(String));
    return pinnedSnapshot;
  };

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

  // Re-assert the pinned block on every open, and re-render so it takes effect
  // before the panel is on screen (then re-place it — the row order can change
  // the panel's height).
  const dropdown = wirePortalDropdown(els.toggle, els.panel, {
    onOpen: () => {
      invalidatePinned();
      renderList();
      dropdown.reposition();
    },
  });

  function renderList() {
    const all = isAll();
    const sel = new Set(specifics().map(String));
    const opts = getOptions();
    const allBox = `<label class="dropdown__item${all ? " is-disabled" : ""}">
      <input type="checkbox" data-mc-all ${all ? "checked disabled" : ""} />
      <span>${escHtml(allLabel)}</span>
    </label>`;
    // Row order under the "All" box: the dead picks (ticked, muted, annotated —
    // and fully clickable, so un-ticking one removes it for good), then the ticked
    // live options (pinned block), then everything else in its own order. One
    // hairline closes the block, unless the block IS the whole list.
    const pin = pinnedSet();
    const dead = deadSpecifics().map((v) => ({ value: v, label: v, dead: true }));
    const pinned = opts.filter((o) => pin.has(String(o.value)));
    const rest = opts.filter((o) => !pin.has(String(o.value)));
    const blockLen = rest.length > 0 ? dead.length + pinned.length : 0;
    const rows = [...dead, ...pinned, ...rest]
      .map((o, i) => {
        const edge = blockLen > 0 && i === blockLen - 1 ? " is-pin-last" : "";
        if (o.dead) {
          return `<label class="dropdown__item dropdown__item--dead${edge}">
        <input type="checkbox" data-mc-value="${escAttr(o.value)}" checked />
        <span>${escHtml(o.label)}</span>
        <span class="dropdown__item-note">${escHtml(DEAD_PICK_NOTE)}</span>
      </label>`;
        }
        return `<label class="dropdown__item${edge}">
        <input type="checkbox" data-mc-value="${escAttr(String(o.value))}" ${sel.has(String(o.value)) ? "checked" : ""} />
        <span>${escHtml(o.label)}</span>
      </label>`;
      })
      .join("");
    els.list.innerHTML = allBox + rows;
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
  return { sync, deadReport, invalidatePinned, close: () => dropdown.close() };
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
    close: () => {
      resultMs.close();
      rcMs.close();
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
/** PotM (Y/N) filter (state.potmYN; Wave D — TASK B) — Won a Player of the Match /
 * Never Player of the Match, over the player's PotM award count in scope. Same
 * checkbox multi-select shape as the toss singletons; buildQuery turns exactly-one
 * selection into a HAVING gate on pom_cte (both/neither is a no-op). */
export function mountPotmYN(container, store, onChange, opts = {}) {
  return mountTokenMultiSelect(container, store, onChange, {
    field: "potmYN", options: POTM_YN_OPTIONS, anyLabel: "Any PotM status", label: "PotM (Y/N)", ...opts,
  });
}
// ── Innings Number picker (state.inningsNumber; filter-rejig Wave R2c) ─────────
// A FORMAT-AWARE checkbox multi-select over the innings a player batted/bowled in
// (1st/2nd for white-ball; up to 4th when Red Ball is in the format selection —
// inningsNumberOptions). Writes state.inningsNumber (1-based DISPLAY ints); the SQL
// half (filters.js) maps each to the 0-based stored innings_number. Same self-
// contained `{ sync }` + portal dropdown shape as the token pickers, but the option
// list is rebuilt on every sync from the current formats — AND any currently-picked
// value that the format no longer offers is kept VISIBLE (a switch to white-ball
// with "4th innings" ticked still shows the 4th box, tickable-off) so a pick is
// never made invisible, and never silently rewritten. Works in both disciplines and
// all formats. Discipline-aware only in the QUERY (which innings the player
// batted/bowled in) — the value set is the same concept either way.
export function mountInningsNumber(container, store, onChange, { embedded = false } = {}) {
  const get = () => store.get().inningsNumber || [];
  const set = (vals) => store.set({ inningsNumber: vals });

  container.innerHTML = `
    <div class="filter-group filter-group--positions" data-role="innum-group">
      ${embedded ? "" : `<span class="filter-label">Innings Number</span>`}
      <div class="dropdown" data-role="innum-dropdown">
        <button type="button" class="select dropdown__toggle" data-role="innum-toggle" aria-haspopup="true" aria-expanded="false">Any innings</button>
        <div class="dropdown__panel" data-role="innum-panel" hidden>
          <div class="dropdown__list" data-role="innum-list"></div>
        </div>
      </div>
    </div>`;

  const els = {
    toggle: container.querySelector('[data-role="innum-toggle"]'),
    panel: container.querySelector('[data-role="innum-panel"]'),
    list: container.querySelector('[data-role="innum-list"]'),
  };

  /** The values to OFFER: the format-aware set plus any picked-but-out-of-scope
   * value (kept so a pick is never made invisible), sorted ascending. */
  function offeredValues() {
    const formatSet = inningsNumberOptions(store.get().formats).map((o) => o.value);
    return [...new Set([...formatSet, ...get()])].sort((a, b) => a - b);
  }

  function updateLabel() {
    const picked = [...get()].sort((a, b) => a - b);
    els.toggle.textContent =
      picked.length === 0
        ? "Any innings"
        : picked.length === 1
        ? inningsNumberLabel(picked[0])
        : `${picked.length} selected`;
  }

  function renderList() {
    const picked = new Set(get());
    els.list.innerHTML = offeredValues()
      .map(
        (v) => `<label class="dropdown__item">
          <input type="checkbox" data-innum-value="${v}" ${picked.has(v) ? "checked" : ""} />
          <span>${escHtml(inningsNumberLabel(v))}</span>
        </label>`
      )
      .join("");
    els.list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const value = Number(cb.dataset.innumValue);
        const current = get().slice();
        const idx = current.indexOf(value);
        if (cb.checked) {
          if (idx === -1) current.push(value);
        } else if (idx !== -1) {
          current.splice(idx, 1);
        }
        set(current.sort((a, b) => a - b));
        updateLabel();
        onChange();
      });
    });
  }

  const dropdown = wirePortalDropdown(els.toggle, els.panel, { onOpen: renderList });

  function sync() {
    updateLabel();
    renderList();
  }

  sync();
  return { sync, close: () => dropdown.close() };
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
 * `onOptionsLoaded` fires after each successful vocabulary load so the caller can
 * refresh anything derived from it (drawer.js's in-popup empty-result notice).
 * Returns `{ sync, deadReport }`. */
export function mountStage(container, store, onChange, { embedded = false, onOptionsLoaded = null } = {}) {
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
    // actively filtering — and now that a pick is never rewritten (see the
    // header), a hidden control holding one would be a permanent, unreachable
    // filter. So the pick wins even while the vocabulary is still loading: the
    // dropdown shows, briefly listing only "All stages", and fills in when the
    // load lands. That is the invisible-pick guarantee.
    hiddenWhen: () => nothingToChoose() && !hasStagePick(),
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
    // The vocabulary — and therefore which picks are dead, and the list's order —
    // just changed. NOTHING is written to state.stage (a pick is never rewritten,
    // see the header); the fresh list only changes what is DISPLAYED: re-pin the
    // ticked stages to the top and tell the caller so it can refresh the notice.
    picker.invalidatePinned();
    picker.sync();
    if (onOptionsLoaded) onOptionsLoaded();
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
  return { sync, deadReport: () => picker.deadReport("Stage"), close: () => picker.close() };
}

// ── Delivery window (ball-grain rebuild Wave 3, owner decision 67; UI-A REWORK) ─
// The delivery window is FOUR independent "+ Add condition" filter entries, each
// a normal singleton with its own row, editor and pill (owner, 2026-07-31: the old
// combined Phase|Overs|Balls mode-TOGGLE is a deprecated style — it forces one mode
// and breaks the uniform per-filter pattern). Each editor writes/reads its OWN
// piece of state.deliveryWindow (see src/deliveryWindow.js's flat spec), preserving
// the others via withDeliveryWindowPiece, so the four compose freely with AND:
//   • Phase        — multi-select chips Powerplay / Middle / Death → spec.phase.
//                    Offered only under a single T20 / 50-over bucket.
//   • Over range   — Overs [from]–[to], format-capped → spec.overs. ALL formats
//                    (the only delivery filter offered on red ball).
//   • Ball range   — Balls [from]–[to] legal team balls, format-capped → spec.balls.
//                    T20 & 50-over only.
//   • Player balls — [First|Last] N balls faced (batting) / bowled (bowling) →
//                    spec.player. ALL formats; on the leaderboard each row is that
//                    player's own N.
// db.js reads the whole spec via setDeliveryWindow() and pushes the generated ball
// predicate into the ball-engine base CTE for every view a query reads, so windows
// DEFINE the numbers (pins obey them) and an empty spec ⇒ null ⇒ byte-identical to
// today. A contradictory combination (e.g. Phase=Powerplay + Over range 15–20)
// yields an honest empty — never special-cased.
//
// The range / player editors keep a LOCAL DRAFT (raw input strings + edge) as the
// UI source of truth and DERIVE a clean, always-valid-or-null piece into the store
// on every edit — so a half-typed range is simply INACTIVE (like an empty
// singleton), never a malformed piece handed to the numbers-critical generator
// (which throws on one). A `lastWritten` guard (the piece's own JSON) means sync()
// only re-reads the draft when THIS piece changed EXTERNALLY (Clear, a format
// prune) — so a store change from a sibling editor mid-keystroke never rewrites the
// input under the caret. The Phase editor is chips only, so it reads state directly
// (no caret to protect).

/** The three phase chips, in canonical (pp→mid→death) order so the emitted
 * phase[] is byte-stable regardless of click order (matches deliveryWindow.js). */
const WINDOW_PHASES = [
  { v: "pp", label: "Powerplay" },
  { v: "mid", label: "Middle" },
  { v: "death", label: "Death" },
];

/** Write ONE piece of state.deliveryWindow, preserving the others (or dropping the
 * whole window when nothing is left) — ONE merge helper so all four editors, their
 * pills and clearSingleton agree, and an all-empty result falls back to null (the
 * byte-identical no-window invariant). */
function setWindowPiece(store, key, value) {
  store.set({ deliveryWindow: withDeliveryWindowPiece(store.get().deliveryWindow, key, value) });
}

/** Format gate (decision 67): Phase + Ball range are offered ONLY under a single
 * T20 or single 50-over bucket. Exported so drawer.js gates the same dropdown
 * entries + rows (Over range + the player clock apply in every format). */
export function windowPhaseBallsAllowed(s) {
  const f = s.formats || [];
  return f.length === 1 && (f[0] === "T20" || f[0] === "50 Over");
}

/** Mount the Phase window editor (spec.phase) — multi-select chips. Chips read
 * state directly (no text input to protect), so sync() just re-paints the active
 * states. `embedded` is accepted for call-site parity (the row names it). */
export function mountWindowPhase(container, store, onChange, { embedded = false } = {}) {
  void embedded;
  container.innerHTML = `
    <div class="dwin-piece" data-role="dwin-phase">
      <div class="dwin__chips">
        ${WINDOW_PHASES.map(
          (p) => `<button type="button" class="chip dwin__chip" data-phase="${p.v}">${escHtml(p.label)}</button>`
        ).join("")}
      </div>
    </div>`;
  const chips = [...container.querySelectorAll(".dwin__chip")];
  const currentPhases = () => {
    const w = store.get().deliveryWindow;
    return new Set(w && Array.isArray(w.phase) ? w.phase : []);
  };
  function renderChips() {
    const cur = currentPhases();
    chips.forEach((c) => c.classList.toggle("is-active", cur.has(c.dataset.phase)));
  }
  chips.forEach((chip) => {
    chip.addEventListener("click", () => {
      const cur = currentPhases();
      const v = chip.dataset.phase;
      if (cur.has(v)) cur.delete(v);
      else cur.add(v);
      // Canonical order so the stored phase[] (and its cache key) is byte-stable.
      const canon = WINDOW_PHASES.map((p) => p.v).filter((x) => cur.has(x));
      setWindowPiece(store, "phase", canon); // [] clears the piece → possibly null
      renderChips();
      onChange();
    });
  });
  function sync() {
    renderChips();
  }
  sync();
  return { sync };
}

/** Shared editor for the two team RANGE pieces (Over range / Ball range). `pieceKey`
 * is "overs" | "balls"; the format cap follows `pieceKey` (Overs: T20 1–20 /
 * 50-over 1–50 / else uncapped; Balls: 1–120 / 1–300). Keeps a local draft +
 * `lastWritten` guard so a sibling editor's store write never stomps the caret. */
function mountWindowRange(container, store, onChange, { pieceKey }) {
  container.innerHTML = `
    <div class="dwin-piece dwin__range" data-role="dwin-range">
      <input type="number" min="1" step="1" class="input dwin__num" data-role="from" placeholder="from" aria-label="From" />
      <span class="dwin__to">to</span>
      <input type="number" min="1" step="1" class="input dwin__num" data-role="to" placeholder="to" aria-label="To" />
    </div>`;
  const fromEl = container.querySelector('[data-role="from"]');
  const toEl = container.querySelector('[data-role="to"]');
  let fromStr = "", toStr = "";
  let lastWritten = "null";

  /** Format cap for this piece (null = uncapped). */
  function capOf() {
    const f = store.get().formats || [];
    const singleT20 = f.length === 1 && f[0] === "T20";
    const single50 = f.length === 1 && f[0] === "50 Over";
    if (pieceKey === "overs") return singleT20 ? 20 : single50 ? 50 : null;
    return singleT20 ? 120 : single50 ? 300 : null;
  }
  /** Draft → a clean, capped {from,to}, or null when incomplete/invalid (inactive). */
  function parseRange(cap) {
    const f = parseInt(fromStr, 10);
    const t = parseInt(toStr, 10);
    if (!Number.isInteger(f) || !Number.isInteger(t)) return null;
    let from = Math.max(1, f);
    let to = Math.max(1, t);
    if (cap) {
      from = Math.min(from, cap);
      to = Math.min(to, cap);
    }
    if (from > to) return null;
    return { from, to };
  }
  /** Recompute the piece from the draft and commit it (set lastWritten BEFORE
   * store.set so the re-entrant sync() from the store notification recognises the
   * write as ours and doesn't stomp the input being typed into). */
  function commit() {
    const val = parseRange(capOf());
    lastWritten = JSON.stringify(val);
    setWindowPiece(store, pieceKey, val);
    onChange();
  }
  function loadDraft(piece) {
    fromStr = piece ? String(piece.from) : "";
    toStr = piece ? String(piece.to) : "";
    fromEl.value = fromStr;
    toEl.value = toStr;
  }
  fromEl.addEventListener("input", () => { fromStr = fromEl.value; commit(); });
  toEl.addEventListener("input", () => { toStr = toEl.value; commit(); });
  // Clamp to the format cap on blur (change), where rewriting the input is safe.
  const clampOnBlur = (el, setStr) =>
    el.addEventListener("change", () => {
      const cap = capOf();
      const n = parseInt(el.value, 10);
      if (Number.isInteger(n) && cap && n > cap) {
        el.value = String(cap);
        setStr(el.value);
      }
      commit();
    });
  clampOnBlur(fromEl, (v) => { fromStr = v; });
  clampOnBlur(toEl, (v) => { toStr = v; });

  function sync() {
    const w = store.get().deliveryWindow;
    const piece = (w && w[pieceKey]) || null;
    const pieceStr = JSON.stringify(piece);
    // Reconcile the draft only when THIS piece changed externally (Clear / prune) —
    // never on our own write (lastWritten was set before the store.set above).
    if (pieceStr !== lastWritten) {
      loadDraft(piece);
      lastWritten = pieceStr;
    }
    const cap = capOf();
    const setMax = (el) => { if (cap) el.max = String(cap); else el.removeAttribute("max"); };
    setMax(fromEl);
    setMax(toEl);
  }
  sync();
  return { sync };
}

/** Mount the Over-range editor (spec.overs) — all formats, the only delivery
 * filter offered on red ball. */
export function mountWindowOvers(container, store, onChange, { embedded = false } = {}) {
  void embedded;
  return mountWindowRange(container, store, onChange, { pieceKey: "overs" });
}

/** Mount the Ball-range editor (spec.balls) — T20 & 50-over only (gated in the
 * dropdown + rows by drawer.js). */
export function mountWindowBalls(container, store, onChange, { embedded = false } = {}) {
  void embedded;
  return mountWindowRange(container, store, onChange, { pieceKey: "balls" });
}

/** Mount the Player-balls editor (spec.player) — [First|Last] N balls, all
 * formats. Unit follows the discipline (faced / bowled). Local draft + lastWritten
 * guard, same as the range editors. */
export function mountWindowPlayer(container, store, onChange, { embedded = false } = {}) {
  void embedded;
  container.innerHTML = `
    <div class="dwin-piece dwin__range" data-role="dwin-player">
      <div class="segmented segmented--small dwin__edge" data-role="edge">
        <button type="button" class="segmented__btn" data-edge="first">First</button>
        <button type="button" class="segmented__btn" data-edge="last">Last</button>
      </div>
      <input type="number" min="1" step="1" class="input dwin__num" data-role="n" placeholder="N" aria-label="Number of balls" />
      <span class="dwin__unit" data-role="unit">balls faced</span>
    </div>`;
  const edgeBtns = [...container.querySelectorAll('[data-role="edge"] .segmented__btn')];
  const nEl = container.querySelector('[data-role="n"]');
  const unitEl = container.querySelector('[data-role="unit"]');
  let edge = "first", nStr = "";
  let lastWritten = "null";

  function buildPiece() {
    const n = parseInt(nStr, 10);
    if (!Number.isInteger(n) || n < 1) return null;
    return { edge, n };
  }
  function commit() {
    const val = buildPiece();
    lastWritten = JSON.stringify(val);
    setWindowPiece(store, "player", val);
    onChange();
  }
  function loadDraft(piece) {
    edge = piece && piece.edge === "last" ? "last" : "first";
    nStr = piece ? String(piece.n) : "";
    nEl.value = nStr;
    renderEdge();
  }
  function renderEdge() {
    edgeBtns.forEach((b) => b.classList.toggle("is-active", b.dataset.edge === edge));
  }
  edgeBtns.forEach((b) =>
    b.addEventListener("click", () => {
      edge = b.dataset.edge;
      renderEdge();
      commit();
    })
  );
  nEl.addEventListener("input", () => { nStr = nEl.value; commit(); });

  function sync() {
    const w = store.get().deliveryWindow;
    const piece = (w && w.player) || null;
    const pieceStr = JSON.stringify(piece);
    if (pieceStr !== lastWritten) {
      loadDraft(piece);
      lastWritten = pieceStr;
    }
    unitEl.textContent = store.get().discipline === "bowling" ? "balls bowled" : "balls faced";
    renderEdge();
  }
  sync();
  // presetEdge (Wave R2 palette): the Batter/Bowler Ball Range ▸ First/Last variant
  // pre-selects the direction from the "+ Add condition" palette. The edge is a LOCAL
  // draft (an incomplete piece — no N yet — writes no state), so a state write alone
  // can't set it; this sets the draft edge and repaints the toggle WITHOUT committing
  // (N is still empty ⇒ the piece stays inactive until the user types N). Byte-neutral
  // to the numbers: no piece is written, so state.deliveryWindow is unchanged.
  function presetEdge(nextEdge) {
    edge = nextEdge === "last" ? "last" : "first";
    renderEdge();
  }
  return { sync, presetEdge };
}

/**
 * Mount the Opponent-player head-to-head picker (state.opponentPlayer — pop-up
 * Tab-2 T-1, owner decision 70). REUSES the shared player-search component
 * (src/omnisearch.js, searchPlayers-backed typeahead) rather than a bespoke one:
 * `showFilterAction:false` turns it into a pure player-value PICKER (no "Filter
 * the table" row), and a chosen row becomes the opponent { id, name }. The results
 * container renders in NORMAL FLOW (`.opp-picker__results`, not the leaderboard's
 * absolute `.omnisearch__results`) so it never gets clipped by the Filters popup's
 * overflow — it just pushes the drawer content down. Ball-engine only (its palette
 * leaf + row are ballOnly-gated in drawer.js). Writes state.opponentPlayer; db.js
 * turns that into the base-CTE ball predicate on Search (numbers-critical path).
 */
export function mountOpponentPlayer(container, store, onChange, { embedded = false } = {}) {
  void embedded;
  container.innerHTML = `
    <div class="opp-picker" data-role="opp-picker">
      <input type="text" class="input opp-picker__input" data-role="opp-input" role="combobox"
             aria-autocomplete="list" aria-expanded="false" autocomplete="off"
             placeholder="Search a player…" aria-label="Opponent player" />
      <div class="opp-picker__results" data-role="opp-results" role="listbox" aria-label="Opponent player search results" hidden></div>
    </div>`;
  const inputEl = container.querySelector('[data-role="opp-input"]');
  const resultsEl = container.querySelector('[data-role="opp-results"]');
  // Tracks the last id we WROTE to the input, so a state change (sync) refreshes
  // the box without clobbering a live search the user is typing.
  let lastWrittenId = null;

  mountOmnisearch(inputEl, resultsEl, {
    showFilterAction: false, // picker mode — no "Filter the table" action row
    onOpenPlayer: (id, name) => {
      lastWrittenId = id;
      inputEl.value = name || "";
      store.set({ opponentPlayer: { id, name } });
      onChange();
    },
  });

  // Clearing the box clears the filter (mirrors the window editors' "empty piece
  // ⇒ no predicate"). A programmatic value set (onOpenPlayer / sync) does NOT fire
  // 'input', so this only ever fires on a real user edit.
  inputEl.addEventListener("input", () => {
    if (inputEl.value.trim() === "" && store.get().opponentPlayer) {
      lastWrittenId = null;
      store.set({ opponentPlayer: null });
      onChange();
    }
  });

  function sync() {
    const opp = store.get().opponentPlayer;
    const id = opp && opp.id ? opp.id : null;
    if (id !== lastWrittenId) {
      inputEl.value = id ? opp.name || opp.id : "";
      lastWrittenId = id;
    }
  }
  sync();
  return { sync };
}

// Game-count meta label (ROUND 3, task 4): "1,013 games" — localized thousands
// separator, the word "games" spelled out. Shown on Team/Opposition/Event/Venue
// rows (Opposition turned on — owner #13, columns rejig wave C).
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
 *     emptyLabel, singular, plural, ariaLabel, searchPlaceholder, deadLabel,
 *     showGames?:bool, siblingExclude?:string[], onOptionsLoaded?():void,
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
 * NEVER touches the selection (owner ruling — see the header).
 * Returns `{ sync, deadReport }`. */
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
    // A pick is never rewritten (see the header), so it can outlive the narrowed
    // option list. It must stay VISIBLE and un-tickable rather than disappear from
    // its own dropdown while still filtering the table.
    keepMissingSelected: true,
    missingNote: DEAD_PICK_NOTE,
    // Ticked values sit in a block at the top of the list, so a pick stops
    // drifting as the games-count ordering re-shuffles around it (owner fix).
    pinSelected: true,
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

  // #26 (audit3 §c, "Escape strands the composer/filter value list"): capture-
  // phase document Escape guard — mirrors columnsPicker.js's onSearchPickerEscape
  // and addPalette.js's own document Escape handler. This panel portals (portal:
  // true, above), so once the user clicks a row (moving focus off the widget's
  // own filter box), Escape skips searchSelect.js's onFilterKeydown entirely and
  // falls straight through to the Filters popup's own document-level Escape
  // handler (main.js), which hides the popup but leaves this panel floating over
  // the table. Guards on the toggle's OWN aria-expanded (no isOpen getter on the
  // handle) so it only acts — and only stops the popup's handler — while the
  // panel is actually open; a second Escape still closes the popup as normal.
  // Every mountScopedMultiSelect caller (Team/Opposition/Event/Venue/City/Season)
  // is mounted ONCE at drawer boot and lives for the app's lifetime (drawer.js's
  // mountFilterDrawer is itself called once from main.js's boot() — never
  // re-rendered/destroyed), so — unlike columnsPicker's transient composer editor
  // — this listener needs no re-mount teardown: it is created once, in lockstep
  // with its (permanent) widget.
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      if (!toggleEl || toggleEl.getAttribute("aria-expanded") !== "true") return;
      handle.close({ focusToggle: true });
      e.stopPropagation();
    },
    true
  );

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
    // A fresh list NEVER touches the selection (owner ruling — see the header):
    // setOptions keeps unknown picks (keepMissingSelected) and re-pins the ticked
    // ones to the top; setValues then re-reflects the selection so the toggle
    // summary and the ticks are honest against the new list.
    handle.setOptions(optionsCache);
    handle.setValues(config.get(store.get()));
    // Which picks are dead may have changed — let the caller refresh anything
    // derived from that (drawer.js's in-popup empty-result notice).
    if (config.onOptionsLoaded) config.onOptionsLoaded();
  }

  /** Is EVERY picked value currently impossible? Then this filter alone
   * guarantees an empty result set, which drawer.js turns into the in-popup
   * notice. Answered only from a list that describes the CURRENT state — a stale
   * or not-yet-loaded list must never accuse a perfectly good pick. */
  function deadReport() {
    if (loadedKey === null || loadedKey !== cacheKey()) return null;
    const picks = config.get(store.get()) || [];
    if (picks.length === 0) return null;
    const known = new Set(optionsCache.map((o) => o.value));
    const dead = picks.filter((v) => !known.has(v));
    return dead.length === picks.length ? { label: config.deadLabel, values: dead } : null;
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
  return { sync, deadReport, close: () => handle.close() };
}

/** "Played for" — single gender + team-type-scoped team picker (state.teams).
 * Cascading: narrowed by every other picked match filter INCLUDING Opposition
 * (so with Opposition = Australia this lists the teams that actually played
 * Australia), but never by state.teams itself — hence role: "teams". */
export function mountTeam(container, store, onChange, { onOptionsLoaded = null } = {}) {
  return mountScopedMultiSelect(container, store, onChange, {
    get: (s) => s.teams || [],
    set: (st, arr) => st.set({ teams: arr }),
    siblingExclude: ["teams"],
    deadLabel: "Team",
    onOptionsLoaded,
    loader: (gender, teamType) => {
      const s = store.get(); // A9: scope the Team list to the full Search Conditions
      return searchTeams("", gender, teamType, s.formats, s.dateFrom, s.dateTo, { sel: s, role: "teams" });
    },
    emptyLabel: "Any team",
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
// one-option list is nothing to choose from. The one exception — the
// invisible-pick guarantee, see the header — is an event that IS narrowed right
// now: its dropdown stays on screen (showing the surviving and the dead picks) so
// the narrowing can be seen and undone, because a pick is never rewritten and
// hiding a control that is actively filtering would strand it forever.
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
function mountEventSeasons(container, store, onChange, { onOptionsLoaded = null } = {}) {
  let optionsByEvent = {}; // { [event_name]: [{ event, season, syr, games }] } for loadedKey
  let loadedKey = null;
  let loadToken = 0;
  let loadingKey = null;
  // Per-event pinned block: the seasons ticked when that dropdown was opened (or
  // when the season lists last reloaded), frozen while it stays open — the same
  // rule the other pickers use, so nothing moves under the pointer as you tick.
  const pinnedByEvent = new Map(); // event -> Set<string>|null
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
  /** Picked seasons this event no longer offers — never deleted (a pick is never
   * rewritten), so they must stay visible (and un-tickable) in the dropdown. */
  const deadSeasons = (eventName) => {
    const cur = getES()[eventName];
    if (!Array.isArray(cur)) return [];
    const inScope = new Set(inScopeSeasons(eventName));
    return cur.filter((sn) => !inScope.has(sn));
  };
  /** Any event whose season narrowing is ENTIRELY out of scope — that alone
   * guarantees an empty result set (drawer.js's in-popup notice). Answered only
   * from season lists that describe the CURRENT state. */
  const deadReport = () => {
    if (loadedKey === null || loadedKey !== dataKey()) return null;
    const values = [];
    for (const e of store.get().event || []) {
      const cur = getES()[e];
      if (!Array.isArray(cur) || cur.length === 0) continue;
      const dead = deadSeasons(e);
      if (dead.length === cur.length) values.push(...dead);
    }
    return values.length ? { label: "Season", values } : null;
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
    // A fresh season list NEVER touches state.eventSeasons (owner ruling — see the
    // header). Seasons that have dropped out of scope stay in the narrowing and
    // render as muted rows (deadSeasons above): they are dead disjuncts in the
    // `season IN (…)` list, so keeping them moves no number, and keeping them is
    // what lets the season come back to life when the other filters widen again.
    // The list order changed, so re-pin; then tell the caller (notice refresh).
    pinnedByEvent.clear();
    render();
    if (onOptionsLoaded) onOptionsLoaded();
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
    // Re-assert this event's pinned block on every open, then re-place the panel
    // (the row order can change its height).
    g.dropdown = wirePortalDropdown(g.toggle, g.panel, {
      onOpen: () => {
        pinnedByEvent.delete(eventName);
        renderGroup(eventName);
        g.dropdown.reposition();
      },
    });
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
    // Row order under the "All seasons" box: the picks this event no longer has in
    // scope (ticked, muted, annotated — clickable, so un-ticking one removes it
    // for good), then the ticked in-scope seasons (pinned block), then the rest in
    // season_year_start desc. One hairline closes the block.
    if (!pinnedByEvent.has(eventName)) pinnedByEvent.set(eventName, new Set(sel));
    const pin = pinnedByEvent.get(eventName);
    const dead = deadSeasons(eventName);
    const pinned = all.filter((sn) => pin.has(sn));
    const rest = all.filter((sn) => !pin.has(sn));
    const blockLen = rest.length > 0 ? dead.length + pinned.length : 0;
    // Dead seasons are by definition absent from `all`, so the first dead.length
    // rows are exactly the dead ones.
    const rows = [...dead, ...pinned, ...rest]
      .map((sn, i) => {
        const edge = blockLen > 0 && i === blockLen - 1 ? " is-pin-last" : "";
        if (i < dead.length) {
          return `<label class="dropdown__item dropdown__item--dead${edge}">
          <input type="checkbox" data-season="${escAttr(sn)}" checked />
          <span>${escHtml(sn)}</span>
          <span class="dropdown__item-note">${escHtml(DEAD_PICK_NOTE)}</span>
        </label>`;
        }
        return `<label class="dropdown__item${edge}">
          <input type="checkbox" data-season="${escAttr(sn)}" ${sel.has(sn) ? "checked" : ""} />
          <span>${escHtml(sn)}</span>
        </label>`;
      })
      .join("");
    g.list.innerHTML = allBox + rows;
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
  return { sync, deadReport };
}

/** "Event" — gender + team-type-scoped competition/series picker (state.event),
 * extended (Wave 6 pt2) with a nested season sub-picker below it. */
export function mountEvent(container, store, onChange, { onOptionsLoaded = null } = {}) {
  container.innerHTML = `
    <div class="filter-group filter-group--event" data-role="event-wrap">
      <div data-role="event-ms"></div>
      <div class="event-seasons" data-role="event-seasons" hidden></div>
    </div>`;
  const msHost = container.querySelector('[data-role="event-ms"]');
  const seasonsHost = container.querySelector('[data-role="event-seasons"]');

  const seasons = mountEventSeasons(seasonsHost, store, onChange, { onOptionsLoaded });

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
      deadLabel: "Event",
      onOptionsLoaded,
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
    // Both halves of the Event row can go dead on their own: the event itself, or
    // (event still fine) its season narrowing. Report whichever applies.
    deadReport: () => msController.deadReport() || seasons.deadReport(),
    // Only the Event multi-select itself portals via mountScopedMultiSelect
    // (searchSelect.js); the per-event Season sub-dropdowns (mountEventSeasons)
    // are a separate, not-in-scope portal mechanism — left untouched here.
    close: () => msController.close(),
  };
}

/** "Venue" — gender + team-type-scoped ground picker (state.venue). Cascading:
 * with Event = County Championship this lists ONLY county grounds; never narrowed
 * by state.venue itself (self-exclusion). */
export function mountVenue(container, store, onChange, { onOptionsLoaded = null } = {}) {
  return mountScopedMultiSelect(container, store, onChange, {
    get: (s) => s.venue || [],
    set: (st, arr) => st.set({ venue: arr }),
    siblingExclude: ["venue"],
    deadLabel: "Venue",
    onOptionsLoaded,
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

/** "City" — gender + team-type-scoped city picker (state.city). Cascading like
 * Venue; never narrowed by state.city itself (self-exclusion). City & Season
 * everywhere (2026-08-16). */
export function mountCity(container, store, onChange, { onOptionsLoaded = null } = {}) {
  return mountScopedMultiSelect(container, store, onChange, {
    get: (s) => s.city || [],
    set: (st, arr) => st.set({ city: arr }),
    siblingExclude: ["city"],
    deadLabel: "City",
    onOptionsLoaded,
    loader: (gender, teamType) => {
      const s = store.get(); // scope the City list to the full Search Conditions
      return searchCities("", gender, teamType, s.formats, s.dateFrom, s.dateTo, { sel: s });
    },
    emptyLabel: "Any city",
    singular: "city",
    plural: "cities",
    ariaLabel: "City",
    searchPlaceholder: "Search cities…",
    showGames: true,
  });
}

/** "Season" — gender + team-type-scoped season picker (state.season). Options are
 * ordered newest-first (season_year_start DESC — searchSeasons; the season-order
 * ruling d1eba79). Cascading like Venue; never narrowed by state.season itself.
 * STANDALONE filter, independent of the Event → Season narrowing. City & Season
 * everywhere (2026-08-16). */
export function mountSeason(container, store, onChange, { onOptionsLoaded = null } = {}) {
  return mountScopedMultiSelect(container, store, onChange, {
    get: (s) => s.season || [],
    set: (st, arr) => st.set({ season: arr }),
    siblingExclude: ["season"],
    deadLabel: "Season",
    onOptionsLoaded,
    loader: (gender, teamType) => {
      const s = store.get(); // scope the Season list to the full Search Conditions
      return searchSeasons("", gender, teamType, s.formats, s.dateFrom, s.dateTo, { sel: s });
    },
    emptyLabel: "Any season",
    singular: "season",
    plural: "seasons",
    ariaLabel: "Season",
    searchPlaceholder: "Search seasons…",
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
export function mountOpposition(container, store, onChange, { embedded = false, onOptionsLoaded = null } = {}) {
  void embedded;
  return mountScopedMultiSelect(container, store, onChange, {
    get: (s) => s.opposition || [],
    set: (st, arr) => st.set({ opposition: arr }),
    deadLabel: "Opposition",
    onOptionsLoaded,
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
    showGames: true,
  });
}
