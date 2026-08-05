// src/playerFilterEditor.js
//
// The "Add Filter Row" EDITOR MODAL for the player pop-up's Tab-2 "Filters"
// table (T-2b-ii). Opened by the tab's "Add Filter Row" button (a fresh row) or
// a row's pencil (edit — pre-filled). It owns a LOCAL draft {conditions, scope}
// and NEVER touches the global store: on commit it hands the cleaned draft back
// via onCommit, and the tab (playerFiltersTab.js) owns the row model + query.
//
// The add-condition flow IS the REAL leaderboard palette — createAddPalette +
// createPaletteGroupsBuilder(surface:"popup") — so nothing about "how you add a
// filter" is re-invented (the hard lesson of the design phase: build off the
// real components). The palette's leaf run() calls back into THIS editor's own
// pickMetric, which appends a condition to the draft (not the store). The popup
// surface offers only the per-innings SLICEABLE set (metricSliceable), so every
// scope singleton is withheld and pickSingleton is never fired.
//
// Condition shapes are the canonical T-2b-i ones:
//   numeric  { metricKey, operator:"gte"|"lte"|"eq"|"between", v1, v2 }
//   boolean  { metricKey, yn:true|false }
// A row combines MULTIPLE conditions with AND (one group in this wave).

import { createAddPalette, paletteSkeletonHTML } from "./addPalette.js";
import { createPaletteGroupsBuilder } from "./paletteGroups.js";
import { OPERATORS } from "./advanced.js";
import { createInitialState, emptyAdvancedBlock, FORMAT_BUCKETS } from "./state.js";
import { escHtml, escAttr } from "./html.js";

const TEAM_TYPES = [
  { value: "international", label: "International" },
  { value: "club", label: "Domestic" },
  { value: "both", label: "Both" },
];

const GI = 0; // single AND group per row in this wave (multiple conditions, AND)

/** Fresh, editable clone of a condition block (draft is mutated freely and only
 * committed on save, so the caller's row is never touched mid-edit). */
function cloneConditions(c) {
  const src = c && c.groups ? c : emptyAdvancedBlock();
  return {
    op: src.op || "AND",
    groups: (src.groups || []).map((g) => ({ op: g.op || "AND", conds: (g.conds || []).map((x) => ({ ...x })) })),
  };
}

/** A condition carries `yn` ⇒ it's a Y/N boolean; otherwise numeric. */
const isBooleanCond = (cond) => typeof cond.yn === "boolean";

/** Drop half-typed conditions so a committed row only carries usable filters
 * (booleans are always complete; numerics need v1, and v2 for "between"). */
function cleanConditions(conditions) {
  const groups = (conditions.groups || [])
    .map((g) => ({
      ...g,
      conds: (g.conds || []).filter((c) => {
        if (!c.metricKey) return false;
        if (isBooleanCond(c)) return true;
        if (!Number.isFinite(Number(c.v1)) || c.v1 === "") return false;
        if (c.operator === "between" && (!Number.isFinite(Number(c.v2)) || c.v2 === "")) return false;
        return true;
      }),
    }))
    .filter((g) => g.conds.length > 0);
  return { op: conditions.op || "AND", groups };
}

/**
 * Open the editor modal. Returns nothing; the modal drives itself and calls
 * onCommit({ conditions, scope }) on "Add Filter Row"/"Save", or onClose() when
 * dismissed (either path also removes the modal + closes any open palette panel).
 *
 * deps:
 *   mode "add" | "edit"           — title + commit-button label
 *   initialConditions             — the row's condition block (empty for add)
 *   initialScope { formats, dateFrom, dateTo, teamType } — sticky for add
 *   discipline, gender, formats   — for palette metric eligibility (formats is the
 *                                   pop-up's, used only when the row scope is blank)
 *   isBooleanMetric(key, disc)    — routes a picked leaf to numeric vs Y/N
 *   isPopupFilterMetric(key, disc)— the palette's per-innings sliceable predicate
 *   conditionBaseName(cond, disc, formats) — friendly metric name for a draft row
 *   onCommit({ conditions, scope }), onClose()
 */
export function openFilterRowEditor(hostDoc, deps) {
  const {
    mode = "add",
    initialConditions,
    initialScope,
    discipline,
    gender,
    formats,
    isBooleanMetric,
    isPopupFilterMetric,
    conditionBaseName,
    onCommit,
    onClose,
    // T-2c: the shared scope-singletons controller (playerFilterScope.js) — the
    // reused drawer value editors for Opposition / Event / Venue / Stage / Match &
    // Toss Result / Innings Number / Team + vs-opponent + delivery-window, behind a
    // store adapter. Its rows mount into this modal; on commit the editor reads the
    // draft off it. Absent (older callers) ⇒ no scope singletons, unchanged.
    scopeController = null,
    initialSingletons = null,
    initialDeliveryWindow = null,
    initialOpponentPlayer = null,
  } = deps;

  const draft = {
    conditions: cloneConditions(initialConditions),
    scope: {
      formats: Array.isArray(initialScope?.formats) ? [...initialScope.formats] : null,
      dateFrom: initialScope?.dateFrom ?? null,
      dateTo: initialScope?.dateTo ?? null,
      teamType: initialScope?.teamType ?? "international",
    },
  };
  if (!draft.conditions.groups.length) draft.conditions.groups.push({ op: "AND", conds: [] });

  const isEdit = mode === "edit";
  const title = isEdit ? "Edit Filter Row" : "Add Filter Row";
  // Owner ruling (2026-08-03): BOTH the add AND the edit-mode commit button read
  // "Add Filter Row" (same label as the tab button) — the earlier "Save" assumption
  // was resolved to "Add Filter Row".
  const commitLabel = "Add Filter Row";

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
          <div class="pfe__label">Conditions</div>
          <div class="pfe__conds" data-role="conds"></div>
          <!-- T-2c: the reused scope-singleton value editors mount here (their
               rows are appended by the shared controller's host). -->
          <div class="pfe__scope-rows-host" data-role="scope-rows-host"></div>
          ${paletteSkeletonHTML(GI)}
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
              <input type="month" class="input pfe__date" data-role="date-from" aria-label="From month" />
              <span class="pfe__date-sep">to</span>
              <input type="month" class="input pfe__date" data-role="date-to" aria-label="To month" />
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
  const addctlEl = overlay.querySelector('[data-role="add-palette"]');

  // ── the real "+ Add condition" palette (surface:"popup") ──────────────────────
  // Its leaf run() calls THIS editor's pickMetric, appending to the local draft.
  const paletteState = () => ({
    ...createInitialState(null),
    discipline,
    gender: gender || "male",
    formats: draft.scope.formats && draft.scope.formats.length ? draft.scope.formats : formats && formats.length ? formats : ["T20"],
  });
  // T-2c: the scope singletons offered on the "popup" surface are revealed by the
  // shared controller (pickSingleton), disabled once shown (isPresent/SINGLETON_TYPES),
  // and their ▸-variants pre-fill via its preselect closures. The matchup "Vs" and
  // fielding preselects stay no-ops (those leaves are withheld — paletteGroups.js).
  const noPreselect = () => () => {};
  const buildGroups = createPaletteGroupsBuilder({
    isPresent: scopeController ? (t) => scopeController.isRevealed(t.key) : () => false,
    SINGLETON_TYPES: scopeController ? scopeController.SINGLETON_TYPES : [],
    pickSingleton: scopeController ? (key, preselect) => scopeController.revealSingleton(key, preselect) : () => {},
    pickMetric: (_gi, key) => addCondition(key),
    preselectPhase: scopeController ? scopeController.preselectPhase : noPreselect,
    preselectFielding: noPreselect,
    preselectMatchupVs: noPreselect,
    preselectEdge: scopeController ? scopeController.preselectEdge : noPreselect,
    preselectInningsNumber: scopeController ? scopeController.preselectInningsNumber : noPreselect,
    getVsBowlingTypes: () => null,
    ensureVsBowlingTypesLoaded: () => {},
    metricSliceable: isPopupFilterMetric,
  });
  const palette = createAddPalette({ buildGroups: (gi) => buildGroups(paletteState(), gi, { surface: "popup" }) });

  function group() {
    if (!draft.conditions.groups.length) draft.conditions.groups.push({ op: "AND", conds: [] });
    return draft.conditions.groups[GI];
  }

  function addCondition(key) {
    const cond = isBooleanMetric(key, discipline)
      ? { metricKey: key, yn: true }
      : { metricKey: key, operator: "gte", v1: "", v2: "" };
    group().conds.push(cond);
    renderConditions();
    const inputs = condsEl.querySelectorAll('[data-role="v1"], [data-role="yn"]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  }

  // ── draft condition rows ──────────────────────────────────────────────────────
  function condRowHTML(cond, ci) {
    const base = conditionBaseName(cond, discipline, draft.scope.formats || formats);
    if (isBooleanCond(cond)) {
      return `<div class="pfe-cond" data-ci="${ci}">
          <span class="pfe-cond__name">${escHtml(base)}</span>
          <span class="pfe-cond__op">is</span>
          <select class="select pfe-cond__ctrl" data-role="yn" aria-label="${escAttr(base)} value">
            <option value="yes" ${cond.yn ? "selected" : ""}>Yes</option>
            <option value="no" ${cond.yn ? "" : "selected"}>No</option>
          </select>
          <button type="button" class="icon-btn pfe-cond__remove" data-role="remove-cond" title="Remove condition" aria-label="Remove condition">&times;</button>
        </div>`;
    }
    const opts = OPERATORS.map(
      (o) => `<option value="${escAttr(o.key)}" ${cond.operator === o.key ? "selected" : ""}>${escHtml(o.label)}</option>`
    ).join("");
    const v2 =
      cond.operator === "between"
        ? `<span class="pfe-cond__and">and</span><input type="number" step="any" class="input pfe-cond__val" data-role="v2" value="${escAttr(cond.v2 ?? "")}" aria-label="${escAttr(base)} upper value" />`
        : "";
    return `<div class="pfe-cond" data-ci="${ci}">
        <span class="pfe-cond__name">${escHtml(base)}</span>
        <select class="select pfe-cond__ctrl" data-role="op" aria-label="${escAttr(base)} operator">${opts}</select>
        <input type="number" step="any" class="input pfe-cond__val" data-role="v1" value="${escAttr(cond.v1 ?? "")}" aria-label="${escAttr(base)} value" />
        ${v2}
        <button type="button" class="icon-btn pfe-cond__remove" data-role="remove-cond" title="Remove condition" aria-label="Remove condition">&times;</button>
      </div>`;
  }

  function renderConditions() {
    const conds = group().conds;
    if (conds.length === 0) {
      condsEl.innerHTML = `<p class="pfe__empty">No conditions yet — a row with only a scope compares the player's whole record under it.</p>`;
      return;
    }
    condsEl.innerHTML = conds.map((c, ci) => condRowHTML(c, ci)).join("");
    condsEl.querySelectorAll(".pfe-cond").forEach((rowEl) => {
      const ci = Number(rowEl.dataset.ci);
      const cond = group().conds[ci];
      const opEl = rowEl.querySelector('[data-role="op"]');
      const v1El = rowEl.querySelector('[data-role="v1"]');
      const v2El = rowEl.querySelector('[data-role="v2"]');
      const ynEl = rowEl.querySelector('[data-role="yn"]');
      if (opEl)
        opEl.addEventListener("change", () => {
          cond.operator = opEl.value;
          renderConditions(); // between ↔ single toggles the second input
          const nv = condsEl.querySelectorAll(".pfe-cond")[ci];
          const focusEl = nv && (nv.querySelector('[data-role="v2"]') || nv.querySelector('[data-role="v1"]'));
          if (focusEl) focusEl.focus();
        });
      if (v1El) v1El.addEventListener("input", () => { cond.v1 = v1El.value; });
      if (v2El) v2El.addEventListener("input", () => { cond.v2 = v2El.value; });
      if (ynEl) ynEl.addEventListener("change", () => { cond.yn = ynEl.value === "yes"; });
      const rm = rowEl.querySelector('[data-role="remove-cond"]');
      if (rm)
        rm.addEventListener("click", () => {
          group().conds.splice(ci, 1);
          renderConditions();
        });
    });
  }

  // ── scope controls ────────────────────────────────────────────────────────────
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
        // Preserve FORMAT_BUCKETS order; empty ⇒ null (inherit the pop-up scope).
        const next = FORMAT_BUCKETS.map((b) => b.key).filter((k) => set.has(k));
        draft.scope.formats = next.length ? next : null;
        // T-2c: the per-row scope changed → reload the scope editors' option lists.
        if (scopeController) scopeController.onScopeChanged();
      });
    });
  }
  function renderTeamType() {
    const host = overlay.querySelector('[data-role="teamtype"]');
    host.innerHTML = TEAM_TYPES.map(
      (t) => `<button type="button" class="pfe-seg${draft.scope.teamType === t.value ? " is-active" : ""}" data-tt="${escAttr(t.value)}">${escHtml(t.label)}</button>`
    ).join("");
    host.querySelectorAll("[data-tt]").forEach((btn) => {
      btn.addEventListener("click", () => {
        draft.scope.teamType = btn.dataset.tt;
        renderTeamType();
        if (scopeController) scopeController.onScopeChanged();
      });
    });
  }
  function wireDates() {
    const fromEl = overlay.querySelector('[data-role="date-from"]');
    const toEl = overlay.querySelector('[data-role="date-to"]');
    if (draft.scope.dateFrom) fromEl.value = draft.scope.dateFrom;
    if (draft.scope.dateTo) toEl.value = draft.scope.dateTo;
    fromEl.addEventListener("change", () => {
      draft.scope.dateFrom = fromEl.value || null;
      if (scopeController) scopeController.onScopeChanged();
    });
    toEl.addEventListener("change", () => {
      draft.scope.dateTo = toEl.value || null;
      if (scopeController) scopeController.onScopeChanged();
    });
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────
  function teardown() {
    palette.closeCurrent();
    // Detach the shared scope-singleton host BEFORE removing the modal, so its
    // persistent editors (+ their one-time document listeners) survive the close.
    if (scopeController) scopeController.detach();
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  }
  function cancel() {
    teardown();
    if (onClose) onClose();
  }
  function commit() {
    const conditions = cleanConditions(draft.conditions);
    const scope = { ...draft.scope };
    // T-2c: pull the scope-singleton draft off the controller BEFORE teardown (it
    // reads its live state). deliveryWindow / opponentPlayer are the row's ball
    // predicates (threaded per-call to db.query); the rest are scope WHERE fields.
    const singletons = scopeController ? scopeController.getScopeSingletons() : {};
    const deliveryWindow = scopeController ? scopeController.getDeliveryWindow() : null;
    const opponentPlayer = scopeController ? scopeController.getOpponentPlayer() : null;
    teardown();
    if (onCommit) onCommit({ conditions, scope, singletons, deliveryWindow, opponentPlayer });
  }
  function onKey(e) {
    if (e.key === "Escape") { e.stopPropagation(); cancel(); }
  }

  overlay.querySelector('[data-role="cancel"]').addEventListener("click", cancel);
  overlay.querySelector('[data-role="cancel-2"]').addEventListener("click", cancel);
  overlay.querySelector('[data-role="commit"]').addEventListener("click", commit);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) cancel(); });
  document.addEventListener("keydown", onKey, true);

  renderConditions();
  renderFormats();
  renderTeamType();
  wireDates();
  palette.mountAddPalette(addctlEl);

  // T-2c: attach the shared scope-singleton editors into this modal + start a fresh
  // editor session — reset the draft to this row's singletons and reveal the ones
  // that carry a value (edit pre-fill). scope is passed by REFERENCE (draft.scope
  // is mutated in place by the scope controls above), so the editors' option lists
  // always read the row's live Format / Team type / Date.
  if (scopeController) {
    const scopeRowsHost = overlay.querySelector('[data-role="scope-rows-host"]');
    if (scopeRowsHost) scopeController.mountInto(scopeRowsHost);
    scopeController.begin(
      { scope: draft.scope, discipline, gender: gender || "male", fallbackFormats: formats, onChange: () => {} },
      { singletons: initialSingletons, deliveryWindow: initialDeliveryWindow, opponentPlayer: initialOpponentPlayer }
    );
  }
}
