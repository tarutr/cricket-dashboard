// src/playerFieldingEditor.js
//
// The "Add Filter Row" EDITOR MODAL for the player pop-up's Tab-2 "Filters" table
// in FIELDING discipline (T-3b). Opened by the tab's "Add Filter Row" button (a
// fresh row) or a row's pencil (edit — pre-filled). Like the batting/bowling
// editor (playerFilterEditor.js) it owns a LOCAL draft and NEVER touches the
// global store; on commit it hands the cleaned draft back via onCommit and the
// tab (playerFiltersTab.js) owns the row model + query.
//
// ── Why a SEPARATE editor from playerFilterEditor.js ─────────────────────────
// A fielding row is NOT a per-innings slice of the batting/bowling views — it
// filters the ONE player's FIELDING record (fielding_events), whose dims live on
// a different namespace (state.fielding.*, read by table.js's
// buildFieldingExtraSliceClauses — the T-3a-ext query, UNCHANGED here). So there
// are no numeric/Y/N per-innings conditions and no matchup mode; instead a fixed
// catalogue of fielding dims, each a discrete "+ Add fielding filter" entry.
//
// ── Dim routing (grounded in the T-3a-ext query — numbers sacred) ────────────
// TWO destinations, mirroring what buildFieldingCteSql / buildFieldingRowState honor:
//   • row.singletons  (top-level state, via buildScopeClausesTagged in the sacred
//     buildFieldingCteSql): Team / Opposition / Event / Venue. These reuse the
//     store-adapter scope editors (playerFilterScope.js) — the same rich, cascading
//     drawer editors the batting/bowling editor uses.
//   • row.fielding.*  (via buildFieldingExtraSliceClauses' additive WHERE): every
//     other dim — Wicket Type (kinds) / Batting Position (positions) / Batting Hand
//     (hands) / Role (roles) / specific batter (outBatters) / specific bowler
//     (bowlers) / Bowler Style (bowlerStyles) / Phase (phases) / Over range
//     (overFrom-overTo, 0-based STORED) / Innings Number (inningsNumbers, 0-based
//     STORED) / City (cities) / Season (seasons) / Stage (stage, canonical labels) /
//     Match Result (result) / Toss result (tossResult) / Toss decision (tossDecision).
// Match-context (stage/result/toss) is a fielding.* dim (it reaches `matches` via a
// correlated EXISTS), NOT a top-level scope singleton — so it uses this editor's own
// checklist, NOT the reused mountResult (which also offers resultCondition, a facet
// the fielding query IGNORES → offering it would be a dishonest filter, SPEC §8.4).
//
// ── DATA-DRIVEN availability (owner ruling, T-3a-ext — NO gender hardcode) ────
// The profile-derived + any data-sourced dims (Batting Hand / Role / Bowler Style /
// City / Season / Stage) load their option lists via loadDimOptions on open; a dim
// is OFFERED in the palette ONLY when its list is non-empty. Men return values →
// the filter shows; women return [] for the profile dims (all NULL) → hidden; when
// women's profiles land, options appear and the filter auto-shows. There is ZERO
// `if (!women)` here — the DATA decides.

import { createAddPalette, paletteSkeletonHTML } from "./addPalette.js";
import { mountOpponentPlayer } from "./drawerInnings.js";
import { loadDimOptions } from "./dimOptions.js";
import { canonicalStage } from "./canonicalNames.js";
import {
  FORMAT_BUCKETS,
  FIELDING_PHASE_OPTIONS,
  FIELDING_POSITIONS,
  RESULT_OPTIONS,
  RESULT_ALL,
  TOSS_RESULT_OPTIONS,
  TOSS_DECISION_OPTIONS,
  inningsNumberOptions,
  inningsNumberLabel,
} from "./state.js";
import { INNINGS_NUMBER_FILTER } from "./metrics.js";
import { escHtml, escAttr } from "./html.js";

const GI = 0; // one palette control per fielding editor (single "+ Add fielding filter")

const TEAM_TYPES = [
  { value: "international", label: "International" },
  { value: "club", label: "Domestic" },
  { value: "both", label: "Both" },
];

// Wicket-type (kind) vocabulary — the EXACT literals fielding_events.kind stores
// (buildFieldingSliceClauses emits `kind IN (…)`); the sacred buildFieldingCteSql
// uses the same four literals for its tallies. Display-only labels here.
const WICKET_TYPE_OPTIONS = [
  { value: "caught", label: "Caught" },
  { value: "caught and bowled", label: "Caught & bowled" },
  { value: "stumped", label: "Stumped" },
  { value: "run out", label: "Run out" },
];

// Match-outcome tokens the fielding mctx honors (buildMatchContextClauses) — the
// RESULT_OPTIONS minus the "All" no-narrowing sentinel (fielding needs no sentinel:
// an empty selection is already "no narrowing").
const RESULT_OUTCOME_OPTIONS = RESULT_OPTIONS.filter((o) => o.value !== RESULT_ALL);

// ── The fielding dim catalogue ───────────────────────────────────────────────
// Each entry: a palette label + group + the state.fielding field it writes + how
// its control renders. `source`/`column` mark a DATA-DRIVEN dim (options from
// loadDimOptions → data-driven availability). `numeric` marks integer-valued
// checklists (positions / innings) whose values coerce to ints. `stored` on innings
// means the checklist VALUE is the 0-based stored innings_number (display via label).
const DIMS = [
  { key: "kind",         field: "kinds",         group: "Dismissal", label: "Wicket type",       control: "checklist", options: () => WICKET_TYPE_OPTIONS },
  { key: "position",     field: "positions",     group: "Dismissal", label: "Dismissed batter's position",  control: "checklist", numeric: true,
    options: () => FIELDING_POSITIONS.map((n) => ({ value: n, label: `Position ${n}` })) },
  { key: "hand",         field: "hands",         group: "Dismissal", label: "Batting hand",      control: "checklist", source: "fielding", column: "out_hand" },
  { key: "role",         field: "roles",         group: "Dismissal", label: "Batter role",       control: "checklist", source: "fielding", column: "out_role" },
  { key: "batter",       field: "outBatters",    group: "Dismissal", label: "Specific batter",   control: "player", nameField: "outBatterName", pickLabel: "Dismissed batter" },
  { key: "bowlerStyle",  field: "bowlerStyles",  group: "Bowler",    label: "Bowler style",      control: "checklist", source: "fielding", column: "bowler_style" },
  { key: "bowler",       field: "bowlers",       group: "Bowler",    label: "Specific bowler",   control: "player", nameField: "bowlerName", pickLabel: "Bowler" },
  { key: "phase",        field: "phases",        group: "Delivery",  label: "Phase",             control: "checklist", options: () => FIELDING_PHASE_OPTIONS },
  { key: "overs",        field: null,            group: "Delivery",  label: "Over range",        control: "overrange" },
  { key: "innings",      field: "inningsNumbers", group: "Delivery", label: "Innings number",    control: "checklist", numeric: true, stored: true,
    options: (ctx) => inningsNumberOptions(ctx.formats).map((o) => ({ value: INNINGS_NUMBER_FILTER.toStored(o.value), label: o.label })) },
  { key: "city",         field: "cities",        group: "Match",     label: "City",              control: "checklist", source: "fielding", column: "city" },
  { key: "season",       field: "seasons",       group: "Match",     label: "Season",            control: "checklist", source: "matches", column: "season" },
  { key: "stage",        field: "stage",         group: "Match",     label: "Stage",             control: "checklist", source: "matches", column: "event_stage", canonical: true },
  { key: "result",       field: "result",        group: "Match",     label: "Match result",      control: "checklist", options: () => RESULT_OUTCOME_OPTIONS },
  { key: "tossResult",   field: "tossResult",    group: "Match",     label: "Toss result",       control: "checklist", options: () => TOSS_RESULT_OPTIONS },
  { key: "tossDecision", field: "tossDecision",  group: "Match",     label: "Toss decision",     control: "checklist", options: () => TOSS_DECISION_OPTIONS },
];
const DIM_BY_KEY = new Map(DIMS.map((d) => [d.key, d]));

// The scope singletons offered on the FIELDING editor: the ONLY four the sacred
// buildFieldingCteSql honors at the top level (via buildScopeClausesTagged). Their
// value editors are the reused store-adapter drawer editors (playerFilterScope.js);
// their picks land on row.singletons. (Stage / Result / Toss / Innings are fielding.*
// dims here, NOT scope singletons — see the header.)
const FIELDING_SINGLETONS = [
  { key: "team", label: "Team" },
  { key: "opposition", label: "Opposition" },
  { key: "event", label: "Event" },
  { key: "venue", label: "Venue" },
];
const SINGLETON_LABEL = new Map(FIELDING_SINGLETONS.map((s) => [s.key, s.label]));

// A checklist longer than this gets an inline filter box (City / Season can be long).
const CHECKLIST_FILTER_THRESHOLD = 12;

/**
 * Open the fielding editor modal.
 *
 * deps:
 *   mode "add" | "edit"
 *   initialFielding                 — the row's state.fielding object (empty for add)
 *   initialScope { formats, dateFrom, dateTo, teamType } — sticky for add
 *   initialSingletons               — the row's scope singletons (edit pre-fill), or null
 *   gender                          — the player's gender (scopes the data-driven loaders)
 *   formats                         — the pop-up's formats (fallback when row scope blank)
 *   scopeController                 — the shared playerFilterScope.js controller
 *   onCommit({ fielding, scope, singletons }), onClose()
 */
export function openFieldingRowEditor(hostDoc, deps) {
  const {
    mode = "add",
    initialFielding = null,
    initialScope,
    initialSingletons = null,
    gender,
    formats,
    scopeController = null,
    onCommit,
    onClose,
  } = deps;

  const draft = {
    fielding: cloneFielding(initialFielding),
    scope: {
      formats: Array.isArray(initialScope?.formats) ? [...initialScope.formats] : null,
      dateFrom: initialScope?.dateFrom ?? null,
      dateTo: initialScope?.dateTo ?? null,
      teamType: initialScope?.teamType ?? "international",
    },
  };

  const title = mode === "edit" ? "Edit Filter Row" : "Add Filter Row";
  // Owner ruling (2026-08-03): both add AND edit commit buttons read "Add Filter Row".
  const commitLabel = "Add Filter Row";

  // Which native dims are currently ON screen (a control row is shown). Seeded from
  // the edit pre-fill below; the palette adds/removes.
  const activeDims = new Set();
  // Cached option lists for the DATA-DRIVEN dims, keyed by dim.key. undefined = not
  // loaded yet, [] = loaded-and-empty (→ dim NOT offered — the data-driven hide),
  // else the {value,label} list. Reloaded when the row scope changes.
  const dimOptions = {};

  // ── overlay + card ──────────────────────────────────────────────────────────
  const overlay = document.createElement("div");
  overlay.className = "pfe-overlay";
  overlay.innerHTML = `
    <div class="pfe" role="dialog" aria-modal="true" aria-label="${escAttr(title)}">
      <div class="pfe__head">
        <h3 class="pfe__title">${escHtml(title)}</h3>
        <button type="button" class="icon-btn pfe__close" data-role="cancel" title="Cancel" aria-label="Cancel">&times;</button>
      </div>
      <div class="pfe__body">
        <div class="pfe__section">
          <div class="pfe__label">Fielding filters</div>
          <div class="pfe__conds" data-role="conds"></div>
          <!-- reused scope-singleton editors (Team / Opposition / Event / Venue) -->
          <div class="pfe__scope-rows-host" data-role="scope-rows-host"></div>
          ${paletteSkeletonHTML(GI).replace("Add condition", "Add fielding filter").replace("Add a filter condition", "Add a fielding filter")}
        </div>
        <div class="pfe__section pfe__scope">
          <div class="pfe__label">Scope</div>
          <div class="pfe__scope-row">
            <span class="pfe__scope-key">Format</span>
            <div class="pfe__formats" data-role="formats"></div>
          </div>
          <div class="pfe__scope-row">
            <span class="pfe__scope-key">Team type</span>
            <div class="pfe__teamtype" data-role="teamtype"></div>
          </div>
          <div class="pfe__scope-row">
            <span class="pfe__scope-key">Dates</span>
            <div class="pfe__dates">
              <input type="date" class="input pfe__date" data-role="date-from" aria-label="From date" />
              <span class="pfe__date-sep">to</span>
              <input type="date" class="input pfe__date" data-role="date-to" aria-label="To date" />
            </div>
          </div>
        </div>
      </div>
      <div class="pfe__foot">
        <button type="button" class="btn btn--ghost" data-role="cancel-2">Cancel</button>
        <button type="button" class="btn btn--primary" data-role="commit">${escHtml(commitLabel)}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const condsEl = overlay.querySelector('[data-role="conds"]');
  let addctlEl = overlay.querySelector('[data-role="add-palette"]');

  // ── scope helpers ─────────────────────────────────────────────────────────────
  const effectiveFormats = () =>
    draft.scope.formats && draft.scope.formats.length ? draft.scope.formats : formats && formats.length ? formats : ["T20"];
  const loaderScope = () => ({
    gender: gender || "male",
    formats: effectiveFormats(),
    teamType: draft.scope.teamType ?? "international",
    dateFrom: draft.scope.dateFrom ?? null,
    dateTo: draft.scope.dateTo ?? null,
  });
  const dimCtx = () => ({ formats: effectiveFormats() });

  /** Options for a dim: static list (from `options`) or the loaded data-driven cache. */
  function optionsFor(dim) {
    if (dim.source) return dimOptions[dim.key] || [];
    return dim.options ? dim.options(dimCtx()) : [];
  }
  /** A dim is OFFERABLE iff it is static OR its data-driven list has loaded non-empty
   * (the data-driven availability rule — no gender hardcode). */
  function dimOfferable(dim) {
    if (!dim.source) return true;
    return Array.isArray(dimOptions[dim.key]) && dimOptions[dim.key].length > 0;
  }

  // ── data-driven option loading ────────────────────────────────────────────────
  let optionsToken = 0;
  function loadDataDrivenOptions() {
    const token = ++optionsToken;
    const scope = loaderScope();
    for (const dim of DIMS) {
      if (!dim.source) continue;
      loadDimOptions(dim.source, dim.column, scope)
        .then((vals) => {
          if (token !== optionsToken) return;
          // Owner ruling (2026-08-06): the profile stores the LITERAL string
          // "Unknown" for a player with no known role — hide that one tick-box
          // on the Batter role dim specifically (loadDimOptions only strips
          // NULL/""); every other dim keeps whatever values it loads.
          const rawVals = dim.column === "out_role" ? vals.filter((v) => v !== "Unknown") : vals;
          dimOptions[dim.key] = dim.canonical
            ? [...new Set(rawVals.map((v) => canonicalStage(v)))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((v) => ({ value: v, label: v }))
            : rawVals.map((v) => ({ value: v, label: String(v) }));
          rebuildPalette(); // the offered set / an open control's options may have changed
          if (activeDims.has(dim.key)) renderConditions();
        })
        .catch(() => {
          if (token !== optionsToken) return;
          dimOptions[dim.key] = dimOptions[dim.key] || []; // treat a failed load as "no options" (hide), retriable on next scope change
          rebuildPalette();
        });
    }
  }

  // ── the "+ Add fielding filter" palette ─────────────────────────────────────────
  function buildGroups() {
    const groups = [];
    const nativeLeaf = (dim) => ({ kind: "leaf", label: dim.label, disabled: activeDims.has(dim.key), run: () => activateDim(dim.key) });
    const singletonLeaf = (s) => ({
      kind: "leaf",
      label: s.label,
      disabled: Boolean(scopeController && scopeController.isRevealed(s.key)),
      run: () => { if (scopeController) scopeController.revealSingleton(s.key); },
    });
    const groupItems = (name) =>
      DIMS.filter((d) => d.group === name && dimOfferable(d)).map(nativeLeaf);
    const push = (name, items) => { const kept = items.filter(Boolean); if (kept.length) groups.push({ name, items: kept }); };
    push("Dismissed batter", groupItems("Dismissal"));
    push("Bowler", groupItems("Bowler"));
    push("Delivery", groupItems("Delivery"));
    // Match group folds the native match dims AND the reused scope singletons.
    push("Match", [...FIELDING_SINGLETONS.map(singletonLeaf), ...groupItems("Match")]);
    return groups;
  }

  const palette = createAddPalette({ buildGroups: () => buildGroups() });

  function rebuildPalette() {
    palette.closeCurrent();
    const holder = addctlEl.parentNode;
    if (!holder) return;
    const tmp = document.createElement("div");
    tmp.innerHTML = paletteSkeletonHTML(GI).replace("Add condition", "Add fielding filter").replace("Add a filter condition", "Add a fielding filter");
    const fresh = tmp.firstElementChild;
    holder.replaceChild(fresh, addctlEl);
    addctlEl = fresh;
    palette.mountAddPalette(addctlEl);
  }

  // ── activate / remove a native dim ──────────────────────────────────────────────
  function activateDim(key) {
    const dim = DIM_BY_KEY.get(key);
    if (!dim) return;
    activeDims.add(key);
    // Seed an empty value so the control renders (and a "picked but unset" dim is a
    // no-op in the query — every field guards on length/finite in table.js).
    if (dim.control === "checklist") { if (!Array.isArray(draft.fielding[dim.field])) draft.fielding[dim.field] = []; }
    else if (dim.control === "player") { if (!Array.isArray(draft.fielding[dim.field])) draft.fielding[dim.field] = []; }
    renderConditions();
    rebuildPalette(); // disable the just-added leaf
  }
  function removeDim(key) {
    const dim = DIM_BY_KEY.get(key);
    if (!dim) return;
    activeDims.delete(key);
    if (dim.control === "overrange") { delete draft.fielding.overFrom; delete draft.fielding.overTo; }
    else if (dim.control === "player") { delete draft.fielding[dim.field]; if (dim.nameField) delete draft.fielding[dim.nameField]; }
    else delete draft.fielding[dim.field];
    renderConditions();
    rebuildPalette();
  }

  // ── render the active native-dim control rows ────────────────────────────────────
  function renderConditions() {
    const active = DIMS.filter((d) => activeDims.has(d.key));
    if (active.length === 0) {
      condsEl.innerHTML = `<p class="pfe__empty">No fielding filters yet — a row with only a scope compares the player's whole fielding record under it.</p>`;
      return;
    }
    condsEl.innerHTML = "";
    for (const dim of active) {
      const rowEl = document.createElement("div");
      rowEl.className = "pfe-cond pfe-cond--fielding";
      rowEl.dataset.dim = dim.key;
      rowEl.innerHTML = `
        <span class="pfe-cond__name">${escHtml(dim.label)}</span>
        <div class="pfe-cond__body" data-role="dim-body"></div>
        <button type="button" class="icon-btn pfe-cond__remove" data-role="remove-dim" title="Remove filter" aria-label="Remove ${escAttr(dim.label)} filter">&times;</button>`;
      condsEl.appendChild(rowEl);
      const body = rowEl.querySelector('[data-role="dim-body"]');
      if (dim.control === "checklist") renderChecklist(body, dim);
      else if (dim.control === "player") renderPlayerPicker(body, dim);
      else if (dim.control === "overrange") renderOverRange(body);
      rowEl.querySelector('[data-role="remove-dim"]').addEventListener("click", () => removeDim(dim.key));
    }
  }

  function renderChecklist(body, dim) {
    const opts = optionsFor(dim);
    const selected = new Set((draft.fielding[dim.field] || []).map((v) => String(v)));
    const long = opts.length > CHECKLIST_FILTER_THRESHOLD;
    body.innerHTML = `
      ${long ? `<input type="text" class="input pfe-checklist__filter" data-role="cl-filter" placeholder="Filter…" aria-label="Filter ${escAttr(dim.label)} options" />` : ""}
      <div class="pfe-checklist${long ? " pfe-checklist--scroll" : ""}" role="group" aria-label="${escAttr(dim.label)}">
        ${opts.length === 0 ? `<span class="pfe__empty">No options in this scope.</span>` : opts
          .map((o) => {
            const v = String(o.value);
            return `<label class="pfe-checklist__item" data-label="${escAttr(String(o.label).toLowerCase())}"><input type="checkbox" data-role="cl" data-val="${escAttr(v)}" ${selected.has(v) ? "checked" : ""}/> ${escHtml(String(o.label))}</label>`;
          })
          .join("")}
      </div>`;
    body.querySelectorAll('[data-role="cl"]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const raw = cb.dataset.val;
        const val = dim.numeric ? Number(raw) : raw;
        const cur = draft.fielding[dim.field] || [];
        const has = cur.some((x) => String(x) === raw);
        if (cb.checked && !has) draft.fielding[dim.field] = [...cur, val];
        else if (!cb.checked && has) draft.fielding[dim.field] = cur.filter((x) => String(x) !== raw);
      });
    });
    const filterEl = body.querySelector('[data-role="cl-filter"]');
    if (filterEl) {
      filterEl.addEventListener("input", () => {
        const q = filterEl.value.trim().toLowerCase();
        body.querySelectorAll(".pfe-checklist__item").forEach((it) => {
          it.style.display = !q || it.dataset.label.includes(q) ? "" : "none";
        });
      });
    }
  }

  function renderPlayerPicker(body, dim) {
    const holder = document.createElement("div");
    body.appendChild(holder);
    // Reuse the T-1 omnisearch player picker (drawerInnings.mountOpponentPlayer) via a
    // per-picker store adapter: its `opponentPlayer` slot ↔ this dim's single pick.
    const current = { id: (draft.fielding[dim.field] || [])[0] || null, name: draft.fielding[dim.nameField] || null };
    const pickerStore = {
      get: () => ({ opponentPlayer: current.id ? { id: current.id, name: current.name } : null }),
      set: (patch) => {
        const opp = patch.opponentPlayer;
        if (opp && opp.id) {
          current.id = opp.id; current.name = opp.name || opp.id;
          draft.fielding[dim.field] = [opp.id];
          draft.fielding[dim.nameField] = current.name;
        } else {
          current.id = null; current.name = null;
          delete draft.fielding[dim.field];
          delete draft.fielding[dim.nameField];
        }
      },
      subscribe: () => () => {},
      describeScope: () => "",
    };
    mountOpponentPlayer(holder, pickerStore, () => {}, { embedded: true });
  }

  function renderOverRange(body) {
    // Display overs are 1-based; the query stores 0-based over_number (over 1 =
    // over_number 0). Show display (stored + 1), write stored (display − 1).
    const dispFrom = Number.isFinite(Number(draft.fielding.overFrom)) ? Number(draft.fielding.overFrom) + 1 : "";
    const dispTo = Number.isFinite(Number(draft.fielding.overTo)) ? Number(draft.fielding.overTo) + 1 : "";
    body.innerHTML = `
      <span class="pfe-cond__op">overs</span>
      <input type="number" min="1" step="1" class="input pfe-cond__val" data-role="over-from" value="${escAttr(dispFrom)}" aria-label="Over range from" />
      <span class="pfe-cond__and">to</span>
      <input type="number" min="1" step="1" class="input pfe-cond__val" data-role="over-to" value="${escAttr(dispTo)}" aria-label="Over range to" />`;
    const fromEl = body.querySelector('[data-role="over-from"]');
    const toEl = body.querySelector('[data-role="over-to"]');
    const write = (el, key) => {
      const n = Number(el.value);
      if (el.value !== "" && Number.isFinite(n) && n >= 1) draft.fielding[key] = Math.trunc(n) - 1;
      else delete draft.fielding[key];
    };
    fromEl.addEventListener("input", () => write(fromEl, "overFrom"));
    toEl.addEventListener("input", () => write(toEl, "overTo"));
  }

  // ── scope controls (Format / Team type / Date) ───────────────────────────────────
  function onScopeChanged() {
    if (scopeController) scopeController.onScopeChanged();
    loadDataDrivenOptions(); // a data-driven dim may gain/lose options under the new scope
  }
  function renderFormats() {
    const host = overlay.querySelector('[data-role="formats"]');
    const active = new Set(draft.scope.formats || formats || []);
    host.innerHTML = FORMAT_BUCKETS.map(
      (b) => `<label class="pfe-check"><input type="checkbox" data-fmt="${escAttr(b.key)}" ${active.has(b.key) ? "checked" : ""}/> ${escHtml(b.label)}</label>`
    ).join("");
    host.querySelectorAll("input[data-fmt]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const set = new Set(draft.scope.formats || formats || []);
        if (cb.checked) set.add(cb.dataset.fmt);
        else set.delete(cb.dataset.fmt);
        const next = FORMAT_BUCKETS.map((b) => b.key).filter((k) => set.has(k));
        draft.scope.formats = next.length ? next : null;
        // Innings-number options depend on format (Red Ball → up to 4th) — re-render.
        if (activeDims.has("innings")) renderConditions();
        onScopeChanged();
      });
    });
  }
  function renderTeamType() {
    const host = overlay.querySelector('[data-role="teamtype"]');
    host.innerHTML = TEAM_TYPES.map(
      (t) => `<button type="button" class="pfe-seg${draft.scope.teamType === t.value ? " is-active" : ""}" data-tt="${escAttr(t.value)}">${escHtml(t.label)}</button>`
    ).join("");
    host.querySelectorAll("[data-tt]").forEach((btn) => {
      btn.addEventListener("click", () => { draft.scope.teamType = btn.dataset.tt; renderTeamType(); onScopeChanged(); });
    });
  }
  function wireDates() {
    const fromEl = overlay.querySelector('[data-role="date-from"]');
    const toEl = overlay.querySelector('[data-role="date-to"]');
    if (draft.scope.dateFrom) fromEl.value = draft.scope.dateFrom;
    if (draft.scope.dateTo) toEl.value = draft.scope.dateTo;
    fromEl.addEventListener("change", () => { draft.scope.dateFrom = fromEl.value || null; onScopeChanged(); });
    toEl.addEventListener("change", () => { draft.scope.dateTo = toEl.value || null; onScopeChanged(); });
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────
  function teardown() {
    palette.closeCurrent();
    // Close any OPEN scope-singleton dropdown (Team/Opposition/Event/Venue's
    // searchSelect.js portal, or Stage/Result/Toss*/Innings Number's
    // wirePortalDropdown portal) before detaching the host below. Both portal a
    // panel straight onto <body> while open and only their OWN toggle click
    // restores it — detach() below just unmounts the (now panel-less) host, so a
    // row closed/committed while one of these was still open would otherwise
    // leave that panel floating, detached, on <body> forever. Drives each mounted
    // editor's REAL close() method (playerFilterScope.js's closeOpenPanels) rather
    // than faking a click; a closed dropdown's close() is already a no-op, so this
    // is a no-op the rest of the time.
    if (scopeController) scopeController.closeOpenPanels();
    if (scopeController) scopeController.detach();
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  }
  function cancel() { teardown(); if (onClose) onClose(); }
  function commit() {
    const scope = { ...draft.scope };
    const singletons = scopeController ? scopeController.getScopeSingletons() : {};
    const fielding = cleanFielding(draft.fielding);
    teardown();
    if (onCommit) onCommit({ fielding, scope, singletons });
  }
  function onKey(e) { if (e.key === "Escape") { e.stopPropagation(); cancel(); } }

  overlay.querySelector('[data-role="cancel"]').addEventListener("click", cancel);
  overlay.querySelector('[data-role="cancel-2"]').addEventListener("click", cancel);
  overlay.querySelector('[data-role="commit"]').addEventListener("click", commit);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) cancel(); });
  document.addEventListener("keydown", onKey, true);

  // Seed active native dims from the edit pre-fill.
  for (const dim of DIMS) {
    if (dim.control === "overrange") {
      if (Number.isFinite(Number(draft.fielding.overFrom)) || Number.isFinite(Number(draft.fielding.overTo))) activeDims.add(dim.key);
    } else if (Array.isArray(draft.fielding[dim.field]) && draft.fielding[dim.field].length) {
      activeDims.add(dim.key);
    }
  }

  renderConditions();
  renderFormats();
  renderTeamType();
  wireDates();

  // Reuse the shared scope-singleton editors (Team / Opposition / Event / Venue). Only
  // those four are ever revealed here (the palette offers no other singleton key), so a
  // fielding row's singletons never carry a dim the fielding query can't honor.
  if (scopeController) {
    const scopeRowsHost = overlay.querySelector('[data-role="scope-rows-host"]');
    if (scopeRowsHost) scopeController.mountInto(scopeRowsHost);
    scopeController.begin(
      { scope: draft.scope, discipline: "fielding", gender: gender || "male", fallbackFormats: formats, onChange: rebuildPalette },
      { singletons: initialSingletons, deliveryWindow: null, opponentPlayer: null }
    );
  }

  loadDataDrivenOptions();
  palette.mountAddPalette(addctlEl);
}

/** Fresh editable clone of a row's state.fielding (draft is mutated freely, only
 * committed on save). Copies every T-3a-ext sub-field + the display-name helpers. */
function cloneFielding(f) {
  const src = f || {};
  const out = {};
  for (const k of [
    "kinds", "positions", "phases", "hands", "roles", "outBatters", "bowlers",
    "bowlerStyles", "cities", "inningsNumbers", "seasons", "stage", "result",
    "tossResult", "tossDecision",
  ]) {
    if (Array.isArray(src[k])) out[k] = [...src[k]];
  }
  if (Number.isFinite(Number(src.overFrom))) out.overFrom = Number(src.overFrom);
  if (Number.isFinite(Number(src.overTo))) out.overTo = Number(src.overTo);
  if (src.outBatterName) out.outBatterName = src.outBatterName;
  if (src.bowlerName) out.bowlerName = src.bowlerName;
  return out;
}

/** Drop empty arrays / unset bounds so a no-filter fielding row is `{}` (the query
 * guards each field either way, but a tidy object keeps the row label honest). */
function cleanFielding(f) {
  const out = {};
  for (const [k, v] of Object.entries(f || {})) {
    if (Array.isArray(v)) { if (v.length) out[k] = v; }
    else if (k === "overFrom" || k === "overTo") { if (Number.isFinite(Number(v))) out[k] = Number(v); }
    else if (v != null && v !== "") out[k] = v;
  }
  // Drop orphan display-names whose id list was cleared.
  if (!Array.isArray(out.outBatters)) delete out.outBatterName;
  if (!Array.isArray(out.bowlers)) delete out.bowlerName;
  return out;
}
