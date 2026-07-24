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
// Team/Event/Venue rows show a "<name>  N games" meta; Opposition keeps its plain
// list (no meta) and, since decision 51 (R5-F #14), is enabled for every team type.

import { wirePortalDropdown } from "./filters.js";
import {
  matchupVsActive,
  FIELDING_KIND_OPTIONS,
  FIELDING_PHASE_OPTIONS,
  FIELDING_POSITIONS,
  RESULT_OPTIONS,
  TOSS_RESULT_OPTIONS,
  TOSS_DECISION_OPTIONS,
  INNINGS_ORDER_OPTIONS,
  METHOD_NONE,
  methodOptionLabel,
} from "./state.js";
import { searchTeams, searchEvents, searchVenues, searchEventSeasons } from "./playerData.js";
import { query } from "./db.js";
import { mountSearchMultiSelect } from "./searchSelect.js";
import { escHtml, escAttr } from "./html.js";

const POSITIONS = Array.from({ length: 12 }, (_, i) => i + 1);

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
// Five categorical filters grouped under "Match context" in the "+ Add
// condition…" picker, available in batting, bowling AND matchup views (unlike
// the fielding slices, they have no matchup gate). Four are fixed-vocabulary
// checkbox multi-selects over a TOP-LEVEL state array (result / tossResult /
// tossDecision / inningsOrder); Stage is a scope-loaded checkbox list plus a
// "Knockout" convenience button; Rain-affected matches (state.method, FIX 3) is a
// scope-loaded method multi-select ("Not affected" + the distinct methods).
// Each is the same self-contained `{ sync }` controller as the pickers above and
// slots into a singleton row in drawer.js. None writes anything but its own state
// key, so the query stays byte-identical until a value is set (see filters.js
// buildMatchContextClauses).

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

/** Result filter (state.result) — Won / Lost / Drawn / No result / Tied / Super Over. */
export function mountResult(container, store, onChange, opts = {}) {
  return mountTokenMultiSelect(container, store, onChange, {
    field: "result", options: RESULT_OPTIONS, anyLabel: "Any result", label: "Result", ...opts,
  });
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
// A scope-loaded checkbox list of the raw `event_stage` values, plus a
// "Knockout" convenience button. The option list is loaded from `matches`,
// GENDER-scoped (basic functional UI for part 1 — the polished, fully
// scope-reactive picker is the next task); the QUERY is unaffected by which
// options are shown (it applies `event_stage IN (picked)` regardless).
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

/** A stage value counts as "knockout" for the shortcut iff it is in the vetted
 * KNOCKOUT_STAGES set. */
function isKnockoutStage(stage) {
  return KNOCKOUT_STAGES.has(stage);
}

/** Mount the Stage picker (state.stage). `embedded` suppresses the outer label.
 * Returns `{ sync }`. */
export function mountStage(container, store, onChange, { embedded = false } = {}) {
  const get = () => store.get().stage || [];
  const set = (vals) => store.set({ stage: vals });

  container.innerHTML = `
    <div class="filter-group filter-group--positions" data-role="mc-group">
      ${embedded ? "" : `<span class="filter-label">Stage</span>`}
      <div class="dropdown" data-role="mc-dropdown">
        <button type="button" class="select dropdown__toggle" data-role="mc-toggle" aria-haspopup="true" aria-expanded="false">Any stage</button>
        <div class="dropdown__panel" data-role="mc-panel" hidden>
          <div class="dropdown__quick">
            <button type="button" class="text-btn" data-role="mc-knockout">Knockout games</button>
          </div>
          <div class="dropdown__list" data-role="mc-list"><p class="profile-note">Loading stages…</p></div>
        </div>
      </div>
    </div>`;

  const els = {
    toggle: container.querySelector('[data-role="mc-toggle"]'),
    panel: container.querySelector('[data-role="mc-panel"]'),
    list: container.querySelector('[data-role="mc-list"]'),
    knockout: container.querySelector('[data-role="mc-knockout"]'),
  };

  let stageOptions = null; // string[]; null until loaded
  let loadedGender = null;
  let loading = false;

  const updateLabel = () => {
    const vals = get();
    els.toggle.textContent =
      vals.length === 0 ? "Any stage" : vals.length === 1 ? vals[0] : `${vals.length} selected`;
  };

  wirePortalDropdown(els.toggle, els.panel);

  function renderList() {
    if (stageOptions === null) {
      els.list.innerHTML = `<p class="profile-note">Loading stages…</p>`;
      return;
    }
    if (stageOptions.length === 0) {
      els.list.innerHTML = `<p class="profile-note">No tournament stages in this scope.</p>`;
      return;
    }
    const selected = new Set(get());
    els.list.innerHTML = stageOptions
      .map(
        (s) => `<label class="dropdown__item">
          <input type="checkbox" data-mc-value="${escAttr(s)}" ${selected.has(s) ? "checked" : ""} />
          <span>${escHtml(s)}</span>
        </label>`
      )
      .join("");
    els.list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const value = cb.dataset.mcValue;
        const current = get().slice();
        const idx = current.indexOf(value);
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
  }

  els.knockout.addEventListener("click", () => {
    // Select every in-scope knockout stage (see isKnockoutStage). If the list
    // hasn't loaded yet this no-ops until it does.
    if (!stageOptions) return;
    set(stageOptions.filter(isKnockoutStage));
    updateLabel();
    renderList();
    onChange();
  });

  async function ensureLoaded() {
    const gender = store.get().gender;
    if (loadedGender === gender || loading) return;
    loading = true;
    try {
      const { rows } = await query(
        `SELECT DISTINCT event_stage AS s FROM matches WHERE event_stage IS NOT NULL AND gender = '${String(gender).replace(/'/g, "''")}' ORDER BY event_stage`
      );
      stageOptions = rows.map((r) => r.s);
      loadedGender = gender;
    } catch (e) {
      stageOptions = null; // retry on a later sync
    }
    loading = false;
    renderList();
  }

  function sync() {
    updateLabel();
    // (Re)load when the gender changed since the last load, or on first visible.
    if (loadedGender !== store.get().gender) {
      stageOptions = null;
      ensureLoaded();
    } else {
      renderList();
    }
  }

  sync();
  return { sync };
}

// ── Rain-affected matches picker (state.method) ─────────────────────────────
// FIX 3: replaces the old single "Exclude D/L & method-decided" boolean toggle
// with a full multi-select mirroring the Stage picker's mechanics. Options are
// loaded from `matches` (gender-scoped, like the Stage path) as the distinct
// non-null `method` values present (D/L / VJD / Awarded / Lost fewer wickets),
// PLUS a leading "Not affected" option (the METHOD_NONE sentinel) standing for
// method IS NULL. Empty selection = inactive (query byte-identical). Once a value
// is picked the sole remaining checked box is disabled (min-one guard, like the
// Format dropdown) — the row/pill × is how the whole filter is cleared.

/** Mount the Rain-affected-matches picker (state.method). `embedded` suppresses
 * the outer label. Returns `{ sync }`. */
export function mountMethod(container, store, onChange, { embedded = false } = {}) {
  const get = () => store.get().method || [];
  const set = (vals) => store.set({ method: vals });

  container.innerHTML = `
    <div class="filter-group filter-group--positions" data-role="mc-group">
      ${embedded ? "" : `<span class="filter-label">Rain-affected matches</span>`}
      <div class="dropdown" data-role="mc-dropdown">
        <button type="button" class="select dropdown__toggle" data-role="mc-toggle" aria-haspopup="true" aria-expanded="false">All matches</button>
        <div class="dropdown__panel" data-role="mc-panel" hidden>
          <div class="dropdown__list" data-role="mc-list"><p class="profile-note">Loading methods…</p></div>
        </div>
      </div>
    </div>`;

  const els = {
    toggle: container.querySelector('[data-role="mc-toggle"]'),
    panel: container.querySelector('[data-role="mc-panel"]'),
    list: container.querySelector('[data-role="mc-list"]'),
  };

  let methodOptions = null; // string[] of the raw non-null methods in scope; null until loaded
  let loadedGender = null;
  let loading = false;

  const updateLabel = () => {
    const vals = get();
    els.toggle.textContent =
      vals.length === 0
        ? "All matches"
        : vals.length === 1
        ? methodOptionLabel(vals[0])
        : `${vals.length} selected`;
  };

  wirePortalDropdown(els.toggle, els.panel);

  function renderList() {
    if (methodOptions === null) {
      els.list.innerHTML = `<p class="profile-note">Loading methods…</p>`;
      return;
    }
    // The "Not affected" sentinel (method IS NULL) always leads; the real methods
    // (if any in scope) follow in the order the query returned them.
    const opts = [METHOD_NONE, ...methodOptions];
    const selected = new Set(get());
    const sole = selected.size === 1; // min-one guard: don't let the last box be unchecked here
    els.list.innerHTML = opts
      .map((v) => {
        const isChecked = selected.has(v);
        const disabled = isChecked && sole;
        return `<label class="dropdown__item${disabled ? " is-disabled" : ""}">
          <input type="checkbox" data-mc-value="${escAttr(v)}" ${isChecked ? "checked" : ""} ${disabled ? "disabled" : ""} ${
          disabled ? 'title="At least one method must stay selected — use the × to clear"' : ""
        } />
          <span>${escHtml(methodOptionLabel(v))}</span>
        </label>`;
      })
      .join("");
    els.list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const value = cb.dataset.mcValue;
        const current = get().slice();
        const idx = current.indexOf(value);
        if (cb.checked) {
          if (idx === -1) current.push(value);
        } else if (idx !== -1) {
          if (current.length <= 1) {
            cb.checked = true; // defensive: the disabled attribute should already prevent this
            return;
          }
          current.splice(idx, 1);
        }
        set(current);
        updateLabel();
        renderList(); // re-render so the min-one guard's disabled state tracks the new count
        onChange();
      });
    });
  }

  async function ensureLoaded() {
    const gender = store.get().gender;
    if (loadedGender === gender || loading) return;
    loading = true;
    try {
      const { rows } = await query(
        `SELECT DISTINCT method AS m FROM matches WHERE method IS NOT NULL AND gender = '${String(gender).replace(
          /'/g,
          "''"
        )}' ORDER BY method`
      );
      methodOptions = rows.map((r) => r.m);
      loadedGender = gender;
    } catch (e) {
      methodOptions = null; // retry on a later sync
    }
    loading = false;
    renderList();
  }

  function sync() {
    updateLabel();
    if (loadedGender !== store.get().gender) {
      methodOptions = null;
      ensureLoaded();
    } else {
      renderList();
    }
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
 *     showGames?:bool, disabledWhen?(state)->bool, disabledNote?:string }
 * (the loader closes over `store` to read the format/date scope; the wrapper
 * still calls it with gender + team type.)
 *
 * Options load lazily — on the row becoming visible OR first toggle interaction
 * — and reload when ANY scope dimension changes (gender, team type, format, or
 * date; see cacheKey). filters.js clears the selection on a gender OR team-type
 * change, so a stale pick never survives those; a format/date change reloads the
 * list but does NOT clear the selection (see the final report's CONCERNS).
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
  let optionsCache = [];
  let loadedKey = null;
  let loadToken = 0;
  let loading = false;
  const cacheKey = () => {
    const s = store.get();
    return `${s.gender}|${s.teamType}|${(s.formats || []).join(",")}|${s.dateFrom || ""}|${s.dateTo || ""}`;
  };
  async function ensureLoaded() {
    const key = cacheKey();
    if (loadedKey === key || loading) return;
    loading = true;
    const token = ++loadToken;
    const s = store.get();
    let rows;
    try {
      rows = await config.loader(s.gender, s.teamType);
    } catch (e) {
      loading = false;
      return; // leave options empty; a later open retries
    }
    if (token !== loadToken) return;
    loading = false;
    optionsCache = rows || [];
    loadedKey = key;
    handle.setOptions(optionsCache);
    // Reflect the current selection against the fresh options (keeps the toggle
    // summary + checks honest; setOptions on its own would drop unknown values).
    handle.setValues(config.get(store.get()));
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

/** "Played for" — single gender + team-type-scoped team picker (state.teams). */
export function mountTeam(container, store, onChange) {
  return mountScopedMultiSelect(container, store, onChange, {
    get: (s) => s.teams || [],
    set: (st, arr) => st.set({ teams: arr }),
    loader: (gender, teamType) => {
      const s = store.get(); // A9: scope the Team list to the full Search Conditions
      return searchTeams("", gender, teamType, s.formats, s.dateFrom, s.dateTo);
    },
    emptyLabel: "All teams",
    singular: "team",
    plural: "teams",
    ariaLabel: "Played for team",
    searchPlaceholder: "Search teams…",
    showGames: true,
  });
}

// ── Event → Season nested picker (Wave 6 pt2, owner-approved design §B) ──────
// mountEvent gains a nested season sub-picker rendered directly BELOW the event
// multi-select. Each SELECTED event gets its own group: an "All seasons" box
// plus one box per in-scope season (season_year_start DESC). "All" checked ⟺ no
// narrowing (state.eventSeasons carries no key for that event) — so an event on
// All filters exactly as it did before this picker existed (backward-compatible;
// the query is byte-identical, see filters.js). Unchecking a season auto-unchecks
// All and narrows to the remaining seasons.
//
// Min-one guards mirror the format dropdown (filters.js syncFormatDropdown): the
// "All" box is disabled WHILE checked (so it can't be turned off into an empty
// selection — you narrow by unchecking a SEASON instead), and the sole remaining
// checked season is disabled. An event with ≤1 in-scope season collapses to "All
// seasons" only (no per-season boxes, no narrowing) — the design's edge case.
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
  let loading = false;

  const scopeKey = () => {
    const s = store.get();
    return `${s.gender}|${s.teamType}|${(s.formats || []).join(",")}|${s.dateFrom || ""}|${s.dateTo || ""}`;
  };
  // Cache key: the full scope PLUS the (sorted) selected-event set — a change to
  // either reloads the per-event season lists.
  const dataKey = () => `${scopeKey()}||${[...(store.get().event || [])].sort().join("~")}`;

  const inScopeSeasons = (eventName) => (optionsByEvent[eventName] || []).map((r) => r.season);
  const getES = () => store.get().eventSeasons || {};

  /** Write the season narrowing for one event. A null/empty list — OR a list
   * covering EVERY in-scope season — collapses to "All" (removes the key → no
   * narrowing → byte-identical query), so re-checking the last season snaps back
   * to All rather than emitting a redundant `season IN (all)`. */
  function setEventSeasons(eventName, seasons) {
    const es = { ...getES() };
    const all = inScopeSeasons(eventName);
    const isFull =
      seasons && all.length > 0 && seasons.length >= all.length && all.every((sn) => seasons.includes(sn));
    if (!seasons || seasons.length === 0 || isFull) delete es[eventName];
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
    if (loadedKey === key || loading) return;
    loading = true;
    const token = ++loadToken;
    const s = store.get();
    let rows;
    try {
      rows = await searchEventSeasons(events, s.gender, s.teamType, s.formats, s.dateFrom, s.dateTo);
    } catch (e) {
      loading = false;
      return; // leave options empty; a later sync retries (e.g. pre-column data)
    }
    if (token !== loadToken) return;
    loading = false;
    const grouped = {};
    for (const r of rows) (grouped[r.event] = grouped[r.event] || []).push(r);
    optionsByEvent = grouped;
    loadedKey = key;
    reconcileNarrowing(); // keep any narrowing honest against the freshly-loaded seasons
    render();
  }

  /** After a fresh load (scope OR selection changed), reconcile each event's
   * season narrowing against the seasons NOW in scope: intersect (preserving the
   * in-scope order), and collapse to "All" (drop the key) when the intersection
   * is empty OR already covers every in-scope season. This is what keeps the
   * picker honest when the date window shrinks while an event stays selected —
   * e.g. narrowing to 2024, then a TOOLBAR date change to a 2026-only window
   * (the toolbar date, unlike the popup date, does NOT clear the event): 2024
   * falls out of scope, the group collapses to "All seasons", and the STATE
   * matches (no stale `season IN ('2024')` that would silently return nothing).
   * Only writes when something changed, so it converges (no store-churn loop). */
  function reconcileNarrowing() {
    const es = getES();
    const events = store.get().event || [];
    const next = { ...es };
    let changed = false;
    for (const e of events) {
      const cur = es[e];
      if (!Array.isArray(cur) || cur.length === 0) continue; // already "All"
      const inScope = inScopeSeasons(e);
      const kept = inScope.filter((sn) => cur.includes(sn)); // ∩, in-scope (desc) order
      const isFull = inScope.length > 0 && kept.length >= inScope.length;
      if (kept.length === 0 || isFull) {
        if (e in next) {
          delete next[e];
          changed = true;
        }
      } else if (kept.length !== cur.length || kept.some((sn, i) => sn !== cur[i])) {
        next[e] = kept;
        changed = true;
      }
    }
    if (changed) store.set({ eventSeasons: next });
  }

  function groupHTML(eventName) {
    const all = inScopeSeasons(eventName);
    const cur = getES()[eventName];
    const isNarrowed = Array.isArray(cur) && cur.length > 0;
    const nameHTML = `<div class="event-seasons__name">${escHtml(eventName)}</div>`;
    // Edge case: an event with no season data or a single in-scope season →
    // "All seasons" only (no per-season boxes; nothing to narrow to).
    if (all.length <= 1) {
      return `<div class="event-seasons__group" data-event="${escAttr(eventName)}">
        ${nameHTML}
        <div class="event-seasons__boxes">
          <label class="dropdown__item is-disabled">
            <input type="checkbox" data-all checked disabled />
            <span>All seasons</span>
          </label>
        </div>
      </div>`;
    }
    const sel = new Set(isNarrowed ? cur : all); // All → every season box shown checked
    const allChecked = !isNarrowed;
    const soleSeason = isNarrowed && cur.length === 1 ? cur[0] : null;
    const seasonBoxes = all
      .map((sn) => {
        const checked = sel.has(sn);
        const disabled = sn === soleSeason; // min-one: can't uncheck the last remaining season
        return `<label class="dropdown__item${disabled ? " is-disabled" : ""}">
          <input type="checkbox" data-season="${escAttr(sn)}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} />
          <span>${escHtml(sn)}</span>
        </label>`;
      })
      .join("");
    return `<div class="event-seasons__group" data-event="${escAttr(eventName)}">
      ${nameHTML}
      <div class="event-seasons__boxes">
        <label class="dropdown__item${allChecked ? " is-disabled" : ""}">
          <input type="checkbox" data-all ${allChecked ? "checked disabled" : ""} />
          <span>All seasons</span>
        </label>
        ${seasonBoxes}
      </div>
    </div>`;
  }

  function render() {
    const events = store.get().event || [];
    if (events.length === 0) {
      container.hidden = true;
      container.innerHTML = "";
      return;
    }
    container.hidden = false;
    // Options for the current scope+selection not loaded yet → a light note;
    // ensureLoaded() (kicked from sync) re-renders when it lands.
    if (loadedKey !== dataKey()) {
      container.innerHTML = `<p class="event-seasons__loading profile-note">Loading seasons…</p>`;
      return;
    }
    container.innerHTML =
      `<div class="event-seasons__head">Seasons</div>` + events.map(groupHTML).join("");
  }

  // ONE delegated change handler for every checkbox in every group (the groups
  // are rebuilt via innerHTML, so a per-input listener would need re-attaching —
  // delegation on the stable container avoids that).
  container.addEventListener("change", (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement)) return;
    const groupEl = input.closest("[data-event]");
    if (!groupEl) return;
    const eventName = groupEl.getAttribute("data-event");
    const all = inScopeSeasons(eventName);
    if (input.hasAttribute("data-all")) {
      // "All" is disabled while checked, so this only fires when turning it back
      // ON → clear the narrowing (select every season).
      if (input.checked) setEventSeasons(eventName, null);
    } else if (input.hasAttribute("data-season")) {
      const sn = input.getAttribute("data-season");
      const curES = getES()[eventName];
      // When on "All", the effective starting set is EVERY in-scope season.
      const base = Array.isArray(curES) && curES.length > 0 ? curES.slice() : all.slice();
      let next;
      if (input.checked) {
        next = base.includes(sn) ? base : [...base, sn];
      } else {
        if (base.length <= 1) {
          input.checked = true; // min-one guard (defensive; the sole box is disabled)
          return;
        }
        next = base.filter((x) => x !== sn);
      }
      // Keep the season order stable (in-scope order = season_year_start desc).
      next = all.filter((x) => next.includes(x));
      setEventSeasons(eventName, next);
    } else {
      return;
    }
    onChange();
  });

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
      loader: (gender, teamType) => {
        const s = store.get(); // A9: scope the Event list to the full Search Conditions
        return searchEvents("", gender, teamType, s.formats, s.dateFrom, s.dateTo);
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

/** "Venue" — gender + team-type-scoped ground picker (state.venue). */
export function mountVenue(container, store, onChange) {
  return mountScopedMultiSelect(container, store, onChange, {
    get: (s) => s.venue || [],
    set: (st, arr) => st.set({ venue: arr }),
    loader: (gender, teamType) => {
      const s = store.get(); // A9: scope the Venue list to the full Search Conditions
      return searchVenues("", gender, teamType, s.formats, s.dateFrom, s.dateTo);
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
    loader: (gender, teamType) => {
      const s = store.get(); // A9: scope the Opposition list to the full Search Conditions
      return searchTeams("", gender, teamType, s.formats, s.dateFrom, s.dateTo);
    },
    emptyLabel: "Any opposition",
    singular: "opponent",
    plural: "opponents",
    ariaLabel: "Against opposition",
    searchPlaceholder: "Search teams…",
    showGames: false,
  });
}
