// src/fieldingDimsDrawer.js
//
// The FIELDING board's dim filter rows for the leaderboard "+ Add condition" drawer
// (fielding filter UI, 3.2b2). Generalises the lone `fld_pos` "Dismissed batter's
// position" pattern (drawerInnings.mountFieldingSlicePicker) to the FULL fielding dim
// set — every dim in the SHARED catalogue (src/fieldingDims.js) EXCEPT `position`,
// which stays consolidated on the existing `fld_pos` singleton (offered byte-identically
// on batting/bowling too, so it is NOT duplicated here).
//
// Each dim is a discrete inline condition ROW (never a multi-mode widget —
// [[feedback-uniform-filters]]), revealed by its own palette leaf, writing its own
// `state.fielding.<field>` slot. That slot is read by the SACRED
// buildFieldingSliceClauses / buildFieldingExtraSliceClauses (table.js) — UNCHANGED
// here (numbers sacred, CLAUDE.md Rule 1); this module only SETS the state the
// fielding query already honours.
//
// Data-driven availability (owner ruling — NO gender hardcode): the profile/location
// dims (Batting hand / Bowler style / City / Season / Stage) load their
// option lists via loadDimOptions scoped to the CURRENT leaderboard scope; a dim is
// OFFERED only when its list is non-empty. Men return values → offered; women return
// [] (all NULL) → absent; women's future data auto-shows them. The DATA decides.

import { wirePortalDropdown } from "./filters.js";
import { mountOpponentPlayer } from "./drawerInnings.js";
import { loadDimOptions, hasNullValue } from "./dimOptions.js";
import { canonicalStage } from "./canonicalNames.js";
import { DIMS, CHECKLIST_FILTER_THRESHOLD } from "./fieldingDims.js";
import { escHtml, escAttr } from "./html.js";
import { STAGE_NONE, STAGE_NONE_LABEL } from "./state.js";

// Position stays on the existing `fld_pos` singleton (byte-identical on every board),
// so this controller owns every OTHER catalogue dim.
const CONTROLLER_DIMS = DIMS.filter((d) => d.key !== "position");

/**
 * Mount the fielding-dim rows into `host` and return a controller the drawer wires
 * into its singleton machinery.
 *
 * deps:
 *   host          — the container the dim rows render into (inside the drawer's
 *                   singleton-rows area).
 *   store         — the shared leaderboard store.
 *   onChange      — the drawer's onChange (fires a value-changing edit through to Search).
 *   requestRerender — re-render the drawer's singleton rows + numeric-group palettes
 *                   (WITHOUT firing a query) — used after a reveal/remove and after a
 *                   data-driven option list resolves, so the offered/disabled set settles.
 *
 * Returns { sync, reveal, isPresent, offerable, activeCount, resetSession }.
 */
export function createFieldingDimsController({ host, store, onChange, requestRerender }) {
  // Which dims the user added THIS popup session but hasn't valued yet (mirrors the
  // drawer's sessionAdded for singletons). Reset on every popup open (resetSession).
  const sessionAdded = {};
  // Data-driven option cache, keyed by dim.key. undefined = not loaded; [] =
  // loaded-empty (→ dim NOT offered); else the {value,label} list.
  const dimOptions = {};
  let optionsSig = null; // scope signature the cache reflects
  let optionsToken = 0;

  // ── state.fielding helpers ──────────────────────────────────────────────────
  /** Merge a patch into state.fielding; an `undefined` value DELETES its key (so a
   * cleared over-range bound is absent, not 0 — Number(0) is finite and would emit a
   * spurious `over_number >= 0`). */
  function patchFielding(patch) {
    const cur = { ...(store.get().fielding || {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete cur[k];
      else cur[k] = v;
    }
    store.set({ fielding: cur });
  }
  const listFor = (dim) => (store.get().fielding || {})[dim.field] || [];

  function dimHasValue(dim, s) {
    const f = s.fielding || {};
    if (dim.control === "overrange") return Number.isFinite(Number(f.overFrom)) || Number.isFinite(Number(f.overTo));
    return Array.isArray(f[dim.field]) && f[dim.field].length > 0;
  }

  // ── options ─────────────────────────────────────────────────────────────────
  const effectiveFormats = () => {
    const fmts = store.get().formats;
    return Array.isArray(fmts) && fmts.length ? fmts : [];
  };
  const dimCtx = () => ({ formats: effectiveFormats() });
  const loaderScope = () => {
    const s = store.get();
    return {
      gender: s.gender || "male",
      formats: effectiveFormats(),
      teamType: s.teamType ?? "international",
      dateFrom: s.dateFrom ?? null,
      dateTo: s.dateTo ?? null,
    };
  };
  const scopeSig = () => JSON.stringify(loaderScope());

  /** Options for a dim: static (dim.options) or the loaded data-driven cache. */
  function optionsFor(dim) {
    if (dim.source) return dimOptions[dim.key] || [];
    return dim.options ? dim.options(dimCtx()) : [];
  }
  /** A dim is OFFERABLE iff it is static OR its data-driven list has loaded non-empty. */
  function offerable(dim, s) {
    if (s.discipline !== "fielding") return false;
    if (!dim.source) return true;
    return Array.isArray(dimOptions[dim.key]) && dimOptions[dim.key].length > 0;
  }

  /** (Re)load every data-driven dim's option list for the current scope. Idempotent
   * per scope signature; on resolve, re-render so the offered set + any open list settle. */
  function loadDataDrivenOptions() {
    const sig = scopeSig();
    if (sig === optionsSig) return;
    optionsSig = sig;
    const token = ++optionsToken;
    const scope = loaderScope();
    for (const dim of CONTROLLER_DIMS) {
      if (!dim.source) continue;
      // Stage-only: ALSO check for stage-less matches in scope (event_stage IS NULL),
      // exactly mirroring the batting/bowling Stage filter's "No Stage" mechanism
      // (drawerInnings.js mountStage / searchStages' hasNoStage). Every other
      // data-driven fielding dim resolves `false` here and is untouched.
      const noStagePromise = dim.key === "stage" ? hasNullValue(dim.source, dim.column, scope) : Promise.resolve(false);
      Promise.all([loadDimOptions(dim.source, dim.column, scope), noStagePromise])
        .then(([vals, hasNoStage]) => {
          if (token !== optionsToken) return;
          const rawVals = vals;
          const orderedVals = dim.reverse ? [...rawVals].reverse() : rawVals;
          const named = dim.canonical
            ? [...new Set(rawVals.map((v) => canonicalStage(v)))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((v) => ({ value: v, label: v }))
            // Cutover S1: bowler_style dim carries a displayLabel transform (title-case)
            // for the LABEL only — value stays RAW (checkbox data-val / state / filter).
            : orderedVals.map((v) => ({ value: v, label: dim.displayLabel ? dim.displayLabel(v) : String(v) }));
          // The STAGE_NONE sentinel (state.js — SAME token/label the batting/bowling
          // Stage filter uses) is appended ONLY when the scope actually holds
          // stage-less matches — an option that can only return zero rows is not a
          // choice, same rule the named list already follows.
          dimOptions[dim.key] = dim.key === "stage" && hasNoStage ? [...named, { value: STAGE_NONE, label: STAGE_NONE_LABEL }] : named;
          if (requestRerender) requestRerender();
        })
        .catch(() => {
          if (token !== optionsToken) return;
          dimOptions[dim.key] = dimOptions[dim.key] || []; // failed load ⇒ "no options" (retried on next scope change)
          if (requestRerender) requestRerender();
        });
    }
  }

  // ── skeleton rows (built once) ──────────────────────────────────────────────
  host.innerHTML = CONTROLLER_DIMS.map(
    (dim) => `
      <div class="cond-row" data-fdim="${escAttr(dim.key)}" hidden>
        <div class="cond-row__line">
          <div class="cond-row__main">
            <span class="cond-row__type">${escHtml(dim.label)}</span>
            <div class="cond-row__value" data-role="fd-editor-${escAttr(dim.key)}"></div>
          </div>
          <button type="button" class="icon-btn cond-row__remove" data-remove-fdim="${escAttr(dim.key)}" title="Remove condition" aria-label="Remove ${escAttr(dim.label)} filter">&times;</button>
        </div>
      </div>`
  ).join("");

  const rowEls = {};
  const editors = {};
  for (const dim of CONTROLLER_DIMS) {
    rowEls[dim.key] = host.querySelector(`[data-fdim="${dim.key}"]`);
    const editorHost = host.querySelector(`[data-role="fd-editor-${dim.key}"]`);
    if (dim.control === "checklist") editors[dim.key] = mountChecklist(editorHost, dim);
    else if (dim.control === "player") editors[dim.key] = mountPlayer(editorHost, dim);
    else if (dim.control === "overrange") editors[dim.key] = mountOverRange(editorHost);
    rowEls[dim.key]
      .querySelector(`[data-remove-fdim="${dim.key}"]`)
      .addEventListener("click", () => removeDim(dim.key));
  }

  // ── editors ─────────────────────────────────────────────────────────────────
  function mountChecklist(hostEl, dim) {
    hostEl.innerHTML = `
      <div class="filter-group filter-group--positions">
        <div class="dropdown" data-role="fd-dd">
          <button type="button" class="select dropdown__toggle" data-role="fd-toggle" aria-haspopup="true" aria-expanded="false">Any</button>
          <div class="dropdown__panel" data-role="fd-panel" hidden>
            <input type="text" class="input fd-checklist__filter" data-role="fd-filter" placeholder="Filter…" aria-label="Filter ${escAttr(dim.label)} options" hidden />
            <div class="dropdown__list" data-role="fd-list"></div>
          </div>
        </div>
      </div>`;
    const toggle = hostEl.querySelector('[data-role="fd-toggle"]');
    const panel = hostEl.querySelector('[data-role="fd-panel"]');
    const listEl = hostEl.querySelector('[data-role="fd-list"]');
    const filterEl = hostEl.querySelector('[data-role="fd-filter"]');

    const coerce = (raw, opts) => {
      if (dim.numeric) return Number(raw);
      const opt = opts.find((o) => String(o.value) === raw);
      return opt ? opt.value : raw;
    };

    function updateLabel() {
      const vals = listFor(dim);
      if (!vals.length) { toggle.textContent = "Any"; return; }
      if (vals.length === 1) {
        const opt = optionsFor(dim).find((o) => String(o.value) === String(vals[0]));
        // Fallback (option not yet loaded): still title-case a bowler_style value via
        // the dim's displayLabel — never a raw-value leak into the summary.
        toggle.textContent = opt ? String(opt.label) : dim.displayLabel ? dim.displayLabel(vals[0]) : String(vals[0]);
        return;
      }
      toggle.textContent = `${vals.length} selected`;
    }

    function renderList() {
      const opts = optionsFor(dim);
      const picked = new Set(listFor(dim).map((v) => String(v)));
      const long = opts.length > CHECKLIST_FILTER_THRESHOLD;
      filterEl.hidden = !long;
      listEl.innerHTML =
        opts.length === 0
          ? `<span class="dropdown__empty">No options in this scope.</span>`
          : opts
              .map((o) => {
                const v = String(o.value);
                return `<label class="dropdown__item" data-label="${escAttr(String(o.label).toLowerCase())}">
                  <input type="checkbox" data-fd-val="${escAttr(v)}" ${picked.has(v) ? "checked" : ""} />
                  <span>${escHtml(String(o.label))}</span>
                </label>`;
              })
              .join("");
      listEl.querySelectorAll('[data-fd-val]').forEach((cb) => {
        cb.addEventListener("change", () => {
          const raw = cb.dataset.fdVal;
          const val = coerce(raw, opts);
          const current = listFor(dim).slice();
          const idx = current.findIndex((x) => String(x) === raw);
          if (cb.checked) { if (idx === -1) current.push(val); }
          else if (idx !== -1) current.splice(idx, 1);
          patchFielding({ [dim.field]: current });
          updateLabel();
          onChange();
        });
      });
      if (long && filterEl) {
        filterEl.oninput = () => {
          const q = filterEl.value.trim().toLowerCase();
          listEl.querySelectorAll(".dropdown__item").forEach((it) => {
            it.style.display = !q || it.dataset.label.includes(q) ? "" : "none";
          });
        };
      }
    }

    wirePortalDropdown(toggle, panel, { onOpen: renderList });
    return { sync: () => { updateLabel(); renderList(); } };
  }

  function mountPlayer(hostEl, dim) {
    const adapter = {
      get: () => {
        const f = store.get().fielding || {};
        const id = (f[dim.field] || [])[0] || null;
        return { opponentPlayer: id ? { id, name: f[dim.nameField] || id } : null };
      },
      set: (patch) => {
        const opp = patch.opponentPlayer;
        if (opp && opp.id) patchFielding({ [dim.field]: [opp.id], [dim.nameField]: opp.name || opp.id });
        else patchFielding({ [dim.field]: [], [dim.nameField]: undefined });
      },
      subscribe: () => () => {},
      describeScope: () => "",
    };
    return mountOpponentPlayer(hostEl, adapter, onChange, { embedded: true });
  }

  function mountOverRange(hostEl) {
    // Display overs 1-based; stored over_number 0-based (over 1 = over_number 0).
    hostEl.innerHTML = `
      <span class="cond-row__and">overs</span>
      <input type="number" min="1" step="1" class="input cond-row__value-input" data-role="fd-over-from" placeholder="from" aria-label="Over range from" />
      <span class="cond-row__and">to</span>
      <input type="number" min="1" step="1" class="input cond-row__value-input" data-role="fd-over-to" placeholder="to" aria-label="Over range to" />`;
    const fromEl = hostEl.querySelector('[data-role="fd-over-from"]');
    const toEl = hostEl.querySelector('[data-role="fd-over-to"]');
    const write = (el, key) => {
      const n = Number(el.value);
      if (el.value !== "" && Number.isFinite(n) && n >= 1) patchFielding({ [key]: Math.trunc(n) - 1 });
      else patchFielding({ [key]: undefined });
      onChange();
    };
    fromEl.addEventListener("input", () => write(fromEl, "overFrom"));
    toEl.addEventListener("input", () => write(toEl, "overTo"));
    return {
      sync: () => {
        const f = store.get().fielding || {};
        const df = Number.isFinite(Number(f.overFrom)) ? Number(f.overFrom) + 1 : "";
        const dt = Number.isFinite(Number(f.overTo)) ? Number(f.overTo) + 1 : "";
        if (String(fromEl.value) !== String(df)) fromEl.value = df;
        if (String(toEl.value) !== String(dt)) toEl.value = dt;
      },
    };
  }

  // ── reveal / remove ─────────────────────────────────────────────────────────
  function reveal(dimKey) {
    sessionAdded[dimKey] = true;
    if (requestRerender) requestRerender();
    onChange();
  }
  function removeDim(dimKey) {
    const dim = CONTROLLER_DIMS.find((d) => d.key === dimKey);
    if (!dim) return;
    sessionAdded[dimKey] = false;
    if (dim.control === "overrange") patchFielding({ overFrom: undefined, overTo: undefined });
    else if (dim.control === "player") patchFielding({ [dim.field]: [], [dim.nameField]: undefined });
    else patchFielding({ [dim.field]: [] });
    if (requestRerender) requestRerender();
    onChange();
  }

  // ── public predicates + sync ────────────────────────────────────────────────
  function isPresent(dimKey, s) {
    if (s.discipline !== "fielding") return false;
    const dim = CONTROLLER_DIMS.find((d) => d.key === dimKey);
    if (!dim) return false;
    return dimHasValue(dim, s) || Boolean(sessionAdded[dimKey]);
  }

  function activeCount(s) {
    if (s.discipline !== "fielding") return 0;
    return CONTROLLER_DIMS.reduce((n, dim) => n + (dimHasValue(dim, s) ? 1 : 0), 0);
  }

  function resetSession() {
    for (const k of Object.keys(sessionAdded)) sessionAdded[k] = false;
  }

  function sync() {
    const s = store.get();
    const onFielding = s.discipline === "fielding";
    if (onFielding) loadDataDrivenOptions();
    for (const dim of CONTROLLER_DIMS) {
      rowEls[dim.key].hidden = !isPresent(dim.key, s);
      const ed = editors[dim.key];
      if (ed && ed.sync) ed.sync();
    }
  }

  sync();

  return {
    sync,
    reveal,
    resetSession,
    activeCount,
    isPresent: (dimKey, s) => isPresent(dimKey, s || store.get()),
    offerable: (dimKey, s) => {
      const dim = CONTROLLER_DIMS.find((d) => d.key === dimKey);
      return dim ? offerable(dim, s || store.get()) : false;
    },
  };
}
