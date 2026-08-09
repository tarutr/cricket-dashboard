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
import { createFilterAvailability } from "./filterAvailability.js";
import { OPERATORS } from "./advanced.js";
import { createInitialState, emptyAdvancedBlock, FORMAT_BUCKETS } from "./state.js";
import { query } from "./db.js";
import { orderBowlingTypes } from "./table.js";
import { matchupBucketLabel } from "./metrics.js";
import { escHtml, escAttr } from "./html.js";

// T-2e: the batting-position LIST slice + the matchup-Vs pick. Batting position ticks
// order positions 1..11 (compiled to `batting_position IN (…)` by the tab's slice
// engine); the key is shared with playerFiltersTab.js's conditionToInningsWhere.
const BATTING_POSITION_KEY = "batting_position";
const BATTING_POSITIONS = Array.from({ length: 11 }, (_, i) => i + 1);
/** A LIST condition (batting position multi-select) carries a `positions` array. */
const isListCond = (cond) => Array.isArray(cond.positions);

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
        // T-2e: a batting-position LIST slice is usable once ≥1 position is ticked.
        if (isListCond(c)) return (c.positions || []).some((p) => Number.isInteger(Number(p)));
        if (isBooleanCond(c)) return true;
        // R2: a numeric condition needs its operator chosen — parametric rows start
        // unset (no default), so drop a committed row that never picked one. No-op
        // for every other numeric (they carry a valid gte/lte/eq/between).
        if (!c.operator) return false;
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
    // R2 (2026-08-09): true for a PARAMETRIC threshold metric (Innings Score /
    // Wicket Hauls). Such a condition starts with NO operator selected (owner "no
    // prefills") and its operator <select> carries a blank "Choose…" option. Safe
    // default for any caller that doesn't supply it → behaves as before.
    isParamMetric = () => false,
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
    // T-2e: the row's matchup-Vs bucket ({dim,value}) for edit pre-fill, or null.
    initialMatchupVs = null,
  } = deps;

  const draft = {
    conditions: cloneConditions(initialConditions),
    scope: {
      formats: Array.isArray(initialScope?.formats) ? [...initialScope.formats] : null,
      dateFrom: initialScope?.dateFrom ?? null,
      dateTo: initialScope?.dateTo ?? null,
      teamType: initialScope?.teamType ?? "international",
    },
    // T-2e (owner Option A): the matchup-Vs bucket. Mutually exclusive with the
    // per-innings slices / ball predicates — the palette enforces it via popupLock,
    // and commit() belt-and-braces clears the other side.
    matchupVs: initialMatchupVs && initialMatchupVs.dim ? { ...initialMatchupVs } : null,
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
  // Reassigned on rebuildPalette() (the skeleton is replaced so the offered leaves
  // can change with popupLock / loaded bowling types).
  let addctlEl = overlay.querySelector('[data-role="add-palette"]');

  // ── the real "+ Add condition" palette (surface:"popup") ──────────────────────
  // Its leaf run() calls THIS editor's pickMetric, appending to the local draft.
  const paletteState = () => ({
    ...createInitialState(null),
    discipline,
    gender: gender || "male",
    formats: draft.scope.formats && draft.scope.formats.length ? draft.scope.formats : formats && formats.length ? formats : ["T20"],
  });

  // ── T-2e: fine bowling-type variants for the "vs bowling style" family ─────────
  // Loaded lazily from matchup_batting distinct-values (the SAME source the drawer +
  // toolbar use), ordered identically via table.js's orderBowlingTypes. Until they
  // resolve the family shows just Pace / Spin; on load we rebuild the palette (so the
  // ▸ family gains them) AND re-render the conditions (so the matchup-Vs row's own
  // <select> gains them). Batting-only; a no-op for the bowling tab (hand only).
  let vsBowlingTypes = null;
  let vsTypesLoading = false;
  const getVsBowlingTypes = () => vsBowlingTypes;
  function ensureVsBowlingTypesLoaded() {
    if (vsBowlingTypes || vsTypesLoading || discipline !== "batting") return;
    vsTypesLoading = true;
    query(`SELECT DISTINCT bowling_type AS v FROM matchup_batting WHERE bowling_type <> '(unmapped)'`)
      .then(({ rows }) => {
        vsTypesLoading = false;
        const types = orderBowlingTypes(rows.map((r) => r.v));
        if (types.length) { vsBowlingTypes = types; rebuildPalette(); renderConditions(); }
      })
      .catch(() => { vsTypesLoading = false; }); // leave null so a later build retries
  }

  // ── T-2e: matchup-Vs ↔ per-innings-slice mutual exclusion (owner Option A) ─────
  // A row is EITHER a matchup-Vs row (combines only with scope singletons) OR a
  // per-innings-slice row (per-innings conditions + batting position + ball
  // predicates). The palette enforces it via popupLock, recomputed from the live
  // draft after every change; rebuildPalette re-mounts the offered leaves when the
  // lock (or the loaded bowling types) change.
  function computePopupLock() {
    if (draft.matchupVs) return "matchup";
    const hasCond = group().conds.length > 0;
    const hasBallPred = Boolean(
      scopeController && (scopeController.getDeliveryWindow() || scopeController.getOpponentPlayer())
    );
    return hasCond || hasBallPred ? "slice" : null;
  }

  // T-2c: the scope singletons offered on the "popup" surface are revealed by the
  // shared controller (pickSingleton), disabled once shown (isPresent/SINGLETON_TYPES),
  // and their ▸-variants pre-fill via its preselect closures. T-2e wires the matchup
  // "Vs" family: pickSingleton("vs") + preselectMatchupVs set the row's matchupVs
  // draft (NOT a buildScope singleton). Fielding preselects stay no-ops (withheld).
  const noPreselect = () => () => {};

  // Data-driven filter availability (owner "remove the hardcode everywhere") — the
  // Matchup Vs family's offer is decided by whether the current gender's matchup
  // data exists, not a gender check. Same shared probe as the leaderboard drawer.
  // availabilityOnReady re-mounts the palette + re-renders the draft conditions once
  // a probe resolves (rebuildPalette / renderConditions are hoisted function decls).
  const availability = createFilterAvailability();
  function availabilityOnReady() {
    rebuildPalette();
    renderConditions();
  }

  const buildGroups = createPaletteGroupsBuilder({
    isPresent: scopeController ? (t) => scopeController.isRevealed(t.key) : () => false,
    SINGLETON_TYPES: scopeController ? scopeController.SINGLETON_TYPES : [],
    // "vs" is not a scope singleton — it's the matchup-Vs mode, handled by the editor.
    pickSingleton: (key, preselect) => {
      if (key === "vs") { if (preselect) preselect(); return; }
      if (scopeController) scopeController.revealSingleton(key, preselect);
    },
    pickMetric: (_gi, key) => addCondition(key),
    preselectPhase: scopeController ? scopeController.preselectPhase : noPreselect,
    preselectFielding: noPreselect,
    preselectMatchupVs: (dim, value) => () => setMatchupVs(dim, value),
    preselectEdge: scopeController ? scopeController.preselectEdge : noPreselect,
    preselectInningsNumber: scopeController ? scopeController.preselectInningsNumber : noPreselect,
    getVsBowlingTypes,
    ensureVsBowlingTypesLoaded,
    metricSliceable: isPopupFilterMetric,
    // Data-driven availability (owner "remove the hardcode everywhere") — the
    // Matchup Vs family is offered iff the current gender's matchup data exists
    // (men → yes, women → no today, future women's data → auto-shown). Same
    // shared probe as the leaderboard; re-renders the palette + conditions once a
    // probe resolves. (Profile leaves stay excluded on the popup regardless.)
    isFilterAvailable: (key, s) => availability.isAvailable(key, s),
    ensureFilterAvailabilityLoaded: (s) => availability.ensureLoaded(s, availabilityOnReady),
  });
  const palette = createAddPalette({
    buildGroups: (gi) => buildGroups(paletteState(), gi, { surface: "popup", popupLock: computePopupLock() }),
  });

  // Current lock — rebuild the palette only when it actually changes (avoids
  // re-mounting the skeleton on every keystroke in a value input).
  let currentLock = null;

  /** Re-mount the "+ Add condition" palette against the LIVE draft (popupLock +
   * loaded bowling types). Replaces the addctl skeleton so a stale offered set can't
   * linger; closes any open panel first (a portaled panel would orphan otherwise). */
  function rebuildPalette() {
    palette.closeCurrent();
    const holder = addctlEl.parentNode;
    if (!holder) return;
    const tmp = document.createElement("div");
    tmp.innerHTML = paletteSkeletonHTML(GI);
    const fresh = tmp.firstElementChild;
    holder.replaceChild(fresh, addctlEl);
    addctlEl = fresh;
    palette.mountAddPalette(addctlEl);
  }

  /** Recompute the lock; rebuild the palette iff it changed. Called after any draft
   * change that can flip matchup ↔ slice ↔ empty (add/remove condition, set/clear
   * matchup-Vs, add/remove a ball-predicate scope singleton). */
  function refreshPaletteForLock() {
    const next = computePopupLock();
    if (next !== currentLock) { currentLock = next; rebuildPalette(); }
  }

  function group() {
    if (!draft.conditions.groups.length) draft.conditions.groups.push({ op: "AND", conds: [] });
    return draft.conditions.groups[GI];
  }

  /** Set / change the row's matchup-Vs bucket (owner Option A). Clears any per-innings
   * conditions (mutual exclusion — the palette prevents mixing, this is belt-and-
   * braces so a legacy draft can't smuggle both). Re-render + relock the palette. */
  function setMatchupVs(dim, value) {
    draft.matchupVs = { dim, value };
    group().conds.length = 0;
    renderConditions();
    refreshPaletteForLock();
  }
  function removeMatchupVs() {
    draft.matchupVs = null;
    renderConditions();
    refreshPaletteForLock();
  }

  function addCondition(key) {
    // T-2e: Batting position is a LIST slice (multi-select), not a numeric/boolean.
    const cond = key === BATTING_POSITION_KEY
      ? { metricKey: key, positions: [] }
      : isBooleanMetric(key, discipline)
        ? { metricKey: key, yn: true }
        // R2: parametric metrics start with NO operator (blank until chosen); every
        // other numeric metric keeps the "gte" default, unchanged.
        : { metricKey: key, operator: isParamMetric(key, discipline) ? "" : "gte", v1: "", v2: "" };
    group().conds.push(cond);
    renderConditions();
    refreshPaletteForLock(); // an empty row just became a slice row → hide matchup-Vs
    const inputs = condsEl.querySelectorAll('[data-role="v1"], [data-role="yn"], [data-role="pos"]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  }

  // ── draft condition rows ──────────────────────────────────────────────────────
  function condRowHTML(cond, ci) {
    const base = conditionBaseName(cond, discipline, draft.scope.formats || formats);
    // T-2e: Batting position — a LIST multi-select (tick order positions 1..11).
    if (isListCond(cond)) {
      const sel = new Set((cond.positions || []).map(Number));
      const boxes = BATTING_POSITIONS.map(
        (p) => `<label class="pfe-cond__poschk"><input type="checkbox" data-role="pos" data-pos="${p}" ${sel.has(p) ? "checked" : ""}/> ${p}</label>`
      ).join("");
      return `<div class="pfe-cond pfe-cond--positions" data-ci="${ci}">
          <span class="pfe-cond__name">${escHtml(base)}</span>
          <div class="pfe-cond__positions" role="group" aria-label="${escAttr(base)}">${boxes}</div>
          <button type="button" class="icon-btn pfe-cond__remove" data-role="remove-cond" title="Remove condition" aria-label="Remove condition">&times;</button>
        </div>`;
    }
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
    // R2: parametric rows (Innings Score / Wicket Hauls) prepend a blank "Choose…"
    // option (selected while the operator is unset) so nothing is pre-selected.
    const paramBlank = isParamMetric(cond.metricKey, discipline)
      ? `<option value=""${cond.operator ? "" : " selected"}>Choose…</option>`
      : "";
    const opts = paramBlank + OPERATORS.map(
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

  // ── T-2e: the matchup-Vs draft row (a <select> to change the bucket + × remove) ─
  function matchupVsSelectOptionsHTML() {
    const cur = draft.matchupVs ? `${draft.matchupVs.dim}:${draft.matchupVs.value}` : "";
    const opt = (v, label) => `<option value="${escAttr(v)}" ${v === cur ? "selected" : ""}>${escHtml(label)}</option>`;
    if (discipline === "batting") {
      const types = getVsBowlingTypes() || [];
      let out = opt("group:Pace", "Pace") + opt("group:Spin", "Spin");
      // Keep a fine "type:…" pick selectable even before the async list resolves.
      if (draft.matchupVs && draft.matchupVs.dim === "type" && !types.includes(draft.matchupVs.value)) {
        out += opt(`type:${draft.matchupVs.value}`, matchupBucketLabel(draft.matchupVs.value));
      }
      out += types.map((t) => opt(`type:${t}`, matchupBucketLabel(t))).join("");
      return out;
    }
    return opt("hand:Right-hand bat", "Right-handers") + opt("hand:Left-hand bat", "Left-handers");
  }
  function matchupVsRowHTML() {
    return `<div class="pfe-cond pfe-cond--matchupvs" data-role="matchupvs-row">
        <span class="pfe-cond__name">Matchup (Vs)</span>
        <span class="pfe-cond__op">is</span>
        <select class="select pfe-cond__ctrl" data-role="matchupvs-select" aria-label="Matchup opponent">${matchupVsSelectOptionsHTML()}</select>
        <button type="button" class="icon-btn pfe-cond__remove" data-role="remove-matchupvs" title="Remove matchup filter" aria-label="Remove matchup filter">&times;</button>
      </div>`;
  }

  function renderConditions() {
    const conds = group().conds;
    const hasMatchup = Boolean(draft.matchupVs);
    if (conds.length === 0 && !hasMatchup) {
      condsEl.innerHTML = `<p class="pfe__empty">No conditions yet — a row with only a scope compares the player's whole record under it.</p>`;
      return;
    }
    // Load the batting fine-type variants so the matchup-Vs <select> can offer them
    // (the palette family also triggers this, but an edited matchup row skips it).
    if (hasMatchup && discipline === "batting") ensureVsBowlingTypesLoaded();
    condsEl.innerHTML = (hasMatchup ? matchupVsRowHTML() : "") + conds.map((c, ci) => condRowHTML(c, ci)).join("");

    // matchup-Vs row: change the bucket / remove the whole matchup mode.
    const mvSel = condsEl.querySelector('[data-role="matchupvs-select"]');
    if (mvSel)
      mvSel.addEventListener("change", () => {
        const raw = mvSel.value;
        const i = raw.indexOf(":");
        if (i > 0) setMatchupVs(raw.slice(0, i), raw.slice(i + 1));
      });
    const mvRm = condsEl.querySelector('[data-role="remove-matchupvs"]');
    if (mvRm) mvRm.addEventListener("click", removeMatchupVs);

    // Condition rows (numeric / Y/N / batting-position list) carry a data-ci; the
    // matchup-Vs row does not, so it is skipped by this selector.
    condsEl.querySelectorAll(".pfe-cond[data-ci]").forEach((rowEl) => {
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
          const nv = condsEl.querySelectorAll(".pfe-cond[data-ci]")[ci];
          const focusEl = nv && (nv.querySelector('[data-role="v2"]') || nv.querySelector('[data-role="v1"]'));
          if (focusEl) focusEl.focus();
        });
      if (v1El) v1El.addEventListener("input", () => { cond.v1 = v1El.value; });
      if (v2El) v2El.addEventListener("input", () => { cond.v2 = v2El.value; });
      if (ynEl) ynEl.addEventListener("change", () => { cond.yn = ynEl.value === "yes"; });
      // Batting-position checkboxes (LIST slice).
      rowEl.querySelectorAll('[data-role="pos"]').forEach((cb) => {
        cb.addEventListener("change", () => {
          const p = Number(cb.dataset.pos);
          const set = new Set((cond.positions || []).map(Number));
          if (cb.checked) set.add(p);
          else set.delete(p);
          cond.positions = [...set].sort((a, b) => a - b);
        });
      });
      const rm = rowEl.querySelector('[data-role="remove-cond"]');
      if (rm)
        rm.addEventListener("click", () => {
          group().conds.splice(ci, 1);
          renderConditions();
          refreshPaletteForLock(); // removing the last slice re-offers matchup-Vs
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
    const scope = { ...draft.scope };
    // T-2c: pull the scope-singleton draft off the controller BEFORE teardown (it
    // reads its live state). deliveryWindow / opponentPlayer are the row's ball
    // predicates (threaded per-call to db.query); the rest are scope WHERE fields.
    const singletons = scopeController ? scopeController.getScopeSingletons() : {};
    // T-2e (owner Option A): a matchup-Vs row routes through buildMatchupQuery, which
    // IGNORES per-innings slices + ball predicates. The palette's popupLock prevents
    // ever adding both, but clear the other side belt-and-braces so a committed row is
    // never a silent lie — a matchup row carries ONLY matchupVs + scope singletons.
    const matchupVs = draft.matchupVs && draft.matchupVs.dim ? { ...draft.matchupVs } : null;
    const conditions = matchupVs ? emptyAdvancedBlock() : cleanConditions(draft.conditions);
    const deliveryWindow = matchupVs ? null : scopeController ? scopeController.getDeliveryWindow() : null;
    const opponentPlayer = matchupVs ? null : scopeController ? scopeController.getOpponentPlayer() : null;
    teardown();
    if (onCommit) onCommit({ conditions, scope, singletons, deliveryWindow, opponentPlayer, matchupVs });
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

  // T-2c: attach the shared scope-singleton editors into this modal + start a fresh
  // editor session — reset the draft to this row's singletons and reveal the ones
  // that carry a value (edit pre-fill). scope is passed by REFERENCE (draft.scope
  // is mutated in place by the scope controls above), so the editors' option lists
  // always read the row's live Format / Team type / Date. onChange → refreshPaletteForLock
  // so revealing/clearing a ball predicate (vs_opp / window) relocks the palette.
  // Begun BEFORE the palette mounts so the first computePopupLock() reads accurate
  // ball-predicate state (edit pre-fill of a ball-predicate row is slice-locked).
  if (scopeController) {
    const scopeRowsHost = overlay.querySelector('[data-role="scope-rows-host"]');
    if (scopeRowsHost) scopeController.mountInto(scopeRowsHost);
    scopeController.begin(
      { scope: draft.scope, discipline, gender: gender || "male", fallbackFormats: formats, onChange: refreshPaletteForLock },
      { singletons: initialSingletons, deliveryWindow: initialDeliveryWindow, opponentPlayer: initialOpponentPlayer }
    );
  }

  // T-2e: seed the lock from the initial draft so the first palette build matches an
  // edited row (matchup → scope-only; slice → no matchup-Vs), then mount.
  currentLock = computePopupLock();
  palette.mountAddPalette(addctlEl);
}
