// src/playerFilterScope.js
//
// The Tab-2 "Filters" editor's SCOPE-SINGLETON machinery (T-2c). It wires the
// per-row Opposition / Event / Venue / Stage / Match & Toss Result / Innings
// Number / Team filters — plus the ball-engine vs-opponent-player + delivery-window
// filters — into the pop-up's "Add Filter Row" editor, by REUSING the drawer's own
// value editors (src/drawerInnings.js) through a STORE-ADAPTER shim (the approach
// the T-2b-ii worker recommended).
//
// ── Why an adapter, and why it is numbers-safe ───────────────────────────────
// mountOpposition / mountEvent / mountStage / mountResult / mountInningsNumber /
// mountOpponentPlayer / mountWindow* are all `(container, store, onChange)` editors
// that read/write via store.get()/store.set(). We can't hand them the global store
// (they'd edit the LEADERBOARD), so this controller presents a store-LIKE object
// (`get`/`set`/`subscribe`/`describeScope`) backed by a LOCAL `singletons` draft:
// get() returns a complete createInitialState() state overlaid with the row's per-
// row scope (Format / Team type / Date, from the editor) + this draft's singleton
// picks; set() records the patch into the draft and re-syncs the mounted editors.
//
// NOTHING here touches a query builder. On commit the editor stores the draft's
// scope fields on the ROW; playerFiltersTab.js's buildRowState sets them on the
// row's clean state, and buildQuery's OWN buildScopeClauses / buildMatchContextClauses
// apply them as WHERE — exactly as they do for the leaderboard. An empty selection
// emits no clause, so a no-filter row stays byte-identical (numbers sacred, Rule 1).
// vs-opponent + delivery-window are ball predicates threaded per-CALL to db.query
// (T-2b-i), so they live on the ROW as deliveryWindow / opponentPlayer, not on the
// SQL state — this controller just SETS them.
//
// ── One persistent instance, reused across editor opens ──────────────────────
// The drawer's editors register document-level portal listeners that they never
// remove (the drawer is mounted once for the app's life). The editor MODAL is
// created + destroyed each open, so mounting fresh editors every time would leak
// those listeners. Instead the TAB creates ONE controller; its host element +
// mounted editors persist. Each editor open calls begin() (reset the draft, reveal
// the row's active singletons) then mountInto(modalEl); each close calls detach()
// (move the host back out before the modal is removed). The editors mount exactly
// once, so their listeners register exactly once — matching the drawer.

import {
  mountTeam,
  mountOpposition,
  mountEvent,
  mountVenue,
  mountStage,
  mountResult,
  mountTossResult,
  mountTossDecision,
  mountInningsNumber,
  mountOpponentPlayer,
  mountWindowPhase,
  mountWindowOvers,
  mountWindowBalls,
  mountWindowPlayer,
} from "./drawerInnings.js";
import {
  createInitialState,
  oppositionFilterActive,
  eventFilterActive,
  venueFilterActive,
  stageFilterActive,
  resultFilterActive,
  resultConditionFilterActive,
  tossResultFilterActive,
  tossDecisionFilterActive,
  inningsNumberFilterActive,
  opponentPlayerActive,
  inningsNumberLabel,
  RESULT_OPTIONS,
  RESULT_ALL,
  RESULT_CONDITION_OPTIONS,
  RESULT_CONDITION_ALL,
  TOSS_RESULT_OPTIONS,
  TOSS_DECISION_OPTIONS,
  STAGE_ALL,
  STAGE_NONE,
  STAGE_NONE_LABEL,
} from "./state.js";
import { withDeliveryWindowPiece, deliveryWindowTokens } from "./deliveryWindow.js";
import { escHtml, escAttr } from "./html.js";

// The plain state fields a scope singleton writes (NOT deliveryWindow / opponentPlayer,
// which live on the row as ball predicates). getScopeSingletons() returns exactly
// these, so buildRowState can overlay them onto the row's clean state.
const SCOPE_STATE_FIELDS = [
  "teams", "opposition", "event", "eventSeasons", "venue",
  "stage", "result", "resultCondition", "tossResult", "tossDecision", "inningsNumber",
];

// Every singleton the pop-up offers: its palette key, its row-label, its editor
// mounter, an `active(state)` predicate (has a value → reveal on edit / disable in
// the palette), an optional `seed` (the "All" defaults Result & Stage get on add,
// mirroring drawer.js pickSingleton) and a `clear` (the state reset on removal,
// mirroring drawer.js clearSingleton). Keys match paletteGroups.js
// POPUP_SCOPE_SINGLETON_KEYS exactly.
const SINGLETON_DEFS = [
  {
    key: "team", label: "Team",
    mount: (h, st, oc) => mountTeam(h, st, oc, {}),
    active: (s) => (s.teams || []).length > 0,
    clear: (st) => st.set({ teams: [] }),
  },
  {
    key: "opposition", label: "Opposition",
    mount: (h, st, oc) => mountOpposition(h, st, oc, { embedded: true }),
    active: (s) => (s.opposition || []).length > 0,
    clear: (st) => st.set({ opposition: [] }),
  },
  {
    key: "event", label: "Event",
    mount: (h, st, oc) => mountEvent(h, st, oc, {}),
    active: (s) => (s.event || []).length > 0,
    clear: (st) => st.set({ event: [], eventSeasons: {} }),
  },
  {
    key: "venue", label: "Venue",
    mount: (h, st, oc) => mountVenue(h, st, oc, {}),
    active: (s) => (s.venue || []).length > 0,
    clear: (st) => st.set({ venue: [] }),
  },
  {
    key: "mc_stage", label: "Stage",
    mount: (h, st, oc) => mountStage(h, st, oc, { embedded: true }),
    active: (s) => (s.stage || []).length > 0,
    seed: (st) => { if (!(st.get().stage || []).length) st.set({ stage: [STAGE_ALL] }); },
    clear: (st) => st.set({ stage: [] }),
  },
  {
    key: "mc_result", label: "Match Result",
    mount: (h, st, oc) => mountResult(h, st, oc, { embedded: true }),
    active: (s) => (s.result || []).length > 0,
    seed: (st) => {
      const s = st.get();
      const patch = {};
      if (!(s.result || []).length) patch.result = [RESULT_ALL];
      if (!(s.resultCondition || []).length) patch.resultCondition = [RESULT_CONDITION_ALL];
      if (Object.keys(patch).length) st.set(patch);
    },
    clear: (st) => st.set({ result: [], resultCondition: [] }),
  },
  {
    key: "mc_toss_result", label: "Toss result",
    mount: (h, st, oc) => mountTossResult(h, st, oc, { embedded: true }),
    active: (s) => (s.tossResult || []).length > 0,
    clear: (st) => st.set({ tossResult: [] }),
  },
  {
    key: "mc_toss_decision", label: "Toss decision",
    mount: (h, st, oc) => mountTossDecision(h, st, oc, { embedded: true }),
    active: (s) => (s.tossDecision || []).length > 0,
    clear: (st) => st.set({ tossDecision: [] }),
  },
  {
    key: "inn_num", label: "Innings Number",
    mount: (h, st, oc) => mountInningsNumber(h, st, oc, { embedded: true }),
    active: (s) => (s.inningsNumber || []).length > 0,
    clear: (st) => st.set({ inningsNumber: [] }),
  },
  {
    key: "vs_opp", label: "vs opponent player",
    mount: (h, st, oc) => mountOpponentPlayer(h, st, oc, { embedded: true }),
    active: (s) => Boolean(s.opponentPlayer && s.opponentPlayer.id),
    clear: (st) => st.set({ opponentPlayer: null }),
  },
  {
    key: "win_phase", label: "Phase",
    mount: (h, st, oc) => mountWindowPhase(h, st, oc, { embedded: true }),
    active: (s) => Boolean(s.deliveryWindow && Array.isArray(s.deliveryWindow.phase) && s.deliveryWindow.phase.length),
    clear: (st) => st.set({ deliveryWindow: withDeliveryWindowPiece(st.get().deliveryWindow, "phase", null) }),
  },
  {
    key: "win_overs", label: "Over range",
    mount: (h, st, oc) => mountWindowOvers(h, st, oc, { embedded: true }),
    active: (s) => Boolean(s.deliveryWindow && s.deliveryWindow.overs),
    clear: (st) => st.set({ deliveryWindow: withDeliveryWindowPiece(st.get().deliveryWindow, "overs", null) }),
  },
  {
    key: "win_balls", label: "Team Ball Range",
    mount: (h, st, oc) => mountWindowBalls(h, st, oc, { embedded: true }),
    active: (s) => Boolean(s.deliveryWindow && s.deliveryWindow.balls),
    clear: (st) => st.set({ deliveryWindow: withDeliveryWindowPiece(st.get().deliveryWindow, "balls", null) }),
  },
  {
    key: "win_player", label: "Batter/Bowler Ball Range",
    mount: (h, st, oc) => mountWindowPlayer(h, st, oc, { embedded: true }),
    active: (s) => Boolean(s.deliveryWindow && s.deliveryWindow.player),
    clear: (st) => st.set({ deliveryWindow: withDeliveryWindowPiece(st.get().deliveryWindow, "player", null) }),
  },
];

const DEF_BY_KEY = new Map(SINGLETON_DEFS.map((d) => [d.key, d]));

// The SINGLETON_TYPES the palette's isPresent/singlePresent consult (only .key is
// read there) — see paletteGroups.js.
export const POPUP_SINGLETON_TYPES = SINGLETON_DEFS.map((d) => ({ key: d.key }));

/**
 * Human labels for a row's ACTIVE scope singletons — one honest token per applied
 * filter (SPEC §8.4), phrased like state.js's describeScope so a scope-only row
 * reads e.g. "vs Australia" rather than the misleading "No conditions". Feeds the
 * row's first-cell label + (i) list (playerFiltersTab.js). Display-only (numbers
 * untouched). `singletons` is the row's SCOPE_STATE_FIELDS; deliveryWindow /
 * opponentPlayer are the row's ball predicates.
 */
export function describeRowSingletons(singletons, deliveryWindow, opponentPlayer, discipline) {
  const s = {
    ...(singletons || {}),
    deliveryWindow: deliveryWindow || null,
    opponentPlayer: opponentPlayer || null,
    discipline,
    gender: "male",
    matchupVs: null,
    view: "table",
  };
  const out = [];
  const labelOf = (vals, opts) => (vals || []).map((v) => opts.find((o) => o.value === v)?.label || v);
  // The tab never runs matchup, so the delivery-window namespace is just the discipline.
  for (const tok of deliveryWindowTokens(s.deliveryWindow, discipline)) out.push(tok.label);
  if (opponentPlayerActive(s)) out.push(`vs ${s.opponentPlayer.name || s.opponentPlayer.id}`);
  if ((s.teams || []).length) out.push(s.teams.length <= 3 ? `Team: ${s.teams.join(", ")}` : `Team: ${s.teams.length} teams`);
  if (oppositionFilterActive(s)) out.push(s.opposition.length <= 3 ? `vs ${s.opposition.join(", ")}` : `vs ${s.opposition.length} opponents`);
  if (eventFilterActive(s)) out.push(s.event.length <= 2 ? `Event: ${s.event.join(", ")}` : `Event: ${s.event.length} events`);
  if (venueFilterActive(s)) out.push(s.venue.length <= 2 ? `Venue: ${s.venue.join(", ")}` : `Venue: ${s.venue.length} venues`);
  if (stageFilterActive(s)) {
    const picks = (s.stage || []).filter((v) => v !== STAGE_ALL).map((v) => (v === STAGE_NONE ? STAGE_NONE_LABEL : v));
    out.push(picks.length <= 3 ? `Stage: ${picks.join(", ")}` : `Stage: ${picks.length} stages`);
  }
  if (resultFilterActive(s)) {
    const outcomes = (s.result || []).filter((v) => v !== RESULT_ALL);
    out.push(`Result: ${labelOf(outcomes, RESULT_OPTIONS).join(", ")}`);
  }
  if (resultConditionFilterActive(s)) {
    const specifics = (s.resultCondition || []).filter((v) => v !== RESULT_CONDITION_ALL);
    out.push(
      specifics.length <= 2
        ? `Result condition: ${labelOf(specifics, RESULT_CONDITION_OPTIONS).join(", ")}`
        : `Result condition: ${specifics.length} conditions`
    );
  }
  if (tossResultFilterActive(s)) out.push(labelOf(s.tossResult, TOSS_RESULT_OPTIONS).join(", "));
  if (tossDecisionFilterActive(s)) out.push(labelOf(s.tossDecision, TOSS_DECISION_OPTIONS).join(", "));
  if (inningsNumberFilterActive(s)) {
    const sorted = [...s.inningsNumber].sort((a, b) => a - b);
    out.push(`Innings: ${sorted.map(inningsNumberLabel).join(", ")}`);
  }
  return out;
}

/**
 * Create the persistent scope-singletons controller (one per tab; see the file
 * header). Returns the API the editor drives; the editor owns the modal, this owns
 * the singleton rows' DOM + the store adapter + the mounted editors.
 */
export function createScopeSingletonsController() {
  // The persistent host holding every revealed singleton row.
  const host = document.createElement("div");
  host.className = "pfe-scope-rows";
  host.setAttribute("data-role", "scope-rows");

  // The local draft state the adapter reads/writes. Only the fields editors touch.
  const singletons = {};
  // The editor supplies the row's per-row scope + discipline/gender via ctx on each
  // begin(); the adapter reads it so the editors' option lists scope correctly.
  let ctx = { scope: {}, discipline: "batting", gender: "male", fallbackFormats: null, onChange: null };
  let baseState = null;

  // ── store adapter ───────────────────────────────────────────────────────────
  function adapterGet() {
    if (!baseState) baseState = createInitialState(null);
    const sc = ctx.scope || {};
    const fb = ctx.fallbackFormats || null;
    const fmts = sc.formats && sc.formats.length ? sc.formats : fb && fb.length ? fb : baseState.formats;
    return {
      ...baseState,
      discipline: ctx.discipline || "batting",
      gender: ctx.gender || "male",
      formats: fmts,
      dateFrom: sc.dateFrom ?? null,
      dateTo: sc.dateTo ?? null,
      teamType: sc.teamType ?? baseState.teamType,
      ...singletons,
    };
  }
  function adapterSet(patch) {
    const next = typeof patch === "function" ? patch(adapterGet()) : patch;
    Object.assign(singletons, next);
    // Cascading + summary refresh: re-sync every mounted editor. sync() is display-
    // only (option-list reloads happen when a sibling changed the cache key); the
    // range/opponent editors' lastWritten/lastWrittenId guards keep this from
    // stomping an input mid-keystroke, exactly as the drawer's syncSingletonRows does.
    syncAll();
  }
  const adapterStore = {
    get: adapterGet,
    set: adapterSet,
    subscribe: () => () => {},
    describeScope: () => "",
  };

  // Each mounted editor's onChange: surface the row-label preview (ctx.onChange).
  // The state write already ran through adapterSet (→ syncAll), so this must NOT
  // re-sync (that would double-work and could re-render a widget mid-onChange).
  const onEditorChange = () => { if (ctx.onChange) ctx.onChange(); };

  const mounted = new Map(); // key -> { rowEl, controller, def }
  const revealed = new Set();

  function syncAll() {
    for (const [, entry] of mounted) {
      try {
        entry.controller.sync();
      } catch (e) {
        // A single editor's sync failing must not break the others.
        console.error("[cricdb] scope-singleton editor sync failed:", e);
      }
    }
  }

  /** Close any OPEN portal dropdown across every mounted singleton editor
   * (Team/Opposition/Event/Venue's searchSelect.js portal; Stage/Result/Toss
   * Result/Toss Decision/Innings Number's wirePortalDropdown portal). Editors
   * with no real close (the inline vs-opponent omnisearch, the numeric window
   * ranges) are safely skipped via the optional chain; a closed editor's own
   * close() is already a no-op. Called by the popup editors' teardown() in
   * place of the old overlay-wide `[aria-expanded="true"]`.click() reach — this
   * drives each editor's REAL close() method instead of faking a user click. */
  function closeOpenPanels() {
    for (const [, entry] of mounted) {
      try {
        entry.controller.close?.();
      } catch (e) {
        // One editor's close failing must not block closing the others.
        console.error("[cricdb] scope-singleton editor close failed:", e);
      }
    }
  }

  function ensureMounted(key) {
    if (mounted.has(key)) return mounted.get(key);
    const def = DEF_BY_KEY.get(key);
    if (!def) return null;
    const rowEl = document.createElement("div");
    rowEl.className = "pfe-scope-row";
    rowEl.dataset.key = key;
    rowEl.hidden = true;
    rowEl.innerHTML = `
      <span class="pfe-scope-row__label">${escHtml(def.label)}</span>
      <div class="pfe-scope-row__editor" data-role="editor"></div>
      <button type="button" class="icon-btn pfe-scope-row__remove" data-role="remove" title="Remove filter" aria-label="Remove ${escAttr(def.label)} filter">&times;</button>`;
    host.appendChild(rowEl);
    const editorHost = rowEl.querySelector('[data-role="editor"]');
    const controller = def.mount(editorHost, adapterStore, onEditorChange);
    rowEl.querySelector('[data-role="remove"]').addEventListener("click", () => removeSingleton(key));
    const entry = { rowEl, controller, def };
    mounted.set(key, entry);
    return entry;
  }

  /** Reveal a singleton row (the palette's pickSingleton): seed its defaults, mount
   * its editor (once), show it, run any preselect, then re-sync. Idempotent — a
   * re-pick of an already-shown singleton just re-runs the seed/preselect. */
  function revealSingleton(key, preselect) {
    const def = DEF_BY_KEY.get(key);
    if (!def) return;
    if (def.seed) def.seed(adapterStore); // seed BEFORE mount so the editor reflects it
    const entry = ensureMounted(key);
    if (!entry) return;
    entry.rowEl.hidden = false;
    revealed.add(key);
    if (preselect) preselect();
    try {
      entry.controller.sync();
    } catch (e) {
      console.error("[cricdb] scope-singleton reveal sync failed:", e);
    }
    if (ctx.onChange) ctx.onChange();
  }

  function removeSingleton(key) {
    const def = DEF_BY_KEY.get(key);
    if (def && def.clear) def.clear(adapterStore); // clears the state field(s) → syncAll
    revealed.delete(key);
    const entry = mounted.get(key);
    if (entry) entry.rowEl.hidden = true;
    if (ctx.onChange) ctx.onChange();
  }

  const isRevealed = (key) => revealed.has(key);

  // Pre-select closures for the palette's ▸ families (parity with drawer.js). Each
  // runs AFTER revealSingleton has mounted the row, so the target editor exists.
  const preselectPhase = (v) => () =>
    adapterStore.set({ deliveryWindow: withDeliveryWindowPiece(adapterStore.get().deliveryWindow, "phase", [v]) });
  const preselectInningsNumber = (n) => () => adapterStore.set({ inningsNumber: [n] });
  const preselectEdge = (edge) => () => {
    const entry = mounted.get("win_player");
    if (entry && entry.controller.presetEdge) entry.controller.presetEdge(edge);
  };

  // ── lifecycle (attach / detach / begin) ──────────────────────────────────────
  function mountInto(parentEl) {
    parentEl.appendChild(host);
  }
  function detach() {
    if (host.parentNode) host.parentNode.removeChild(host);
  }

  /** Start an editor session: adopt the editor's ctx, reset the draft to the row's
   * initial singletons, then reveal every currently-active singleton (edit pre-fill). */
  function begin(nextCtx, initial) {
    ctx = { scope: {}, discipline: "batting", gender: "male", fallbackFormats: null, onChange: null, ...nextCtx };
    for (const k of Object.keys(singletons)) delete singletons[k];
    Object.assign(singletons, (initial && initial.singletons) || {});
    if (initial && initial.deliveryWindow) singletons.deliveryWindow = initial.deliveryWindow;
    if (initial && initial.opponentPlayer) singletons.opponentPlayer = initial.opponentPlayer;
    // Hide every row from the previous session; reveal the ones this row uses.
    revealed.clear();
    for (const [, entry] of mounted) entry.rowEl.hidden = true;
    const s = adapterGet();
    for (const def of SINGLETON_DEFS) {
      if (def.active(s)) {
        const entry = ensureMounted(def.key);
        if (entry) {
          entry.rowEl.hidden = false;
          revealed.add(def.key);
        }
      }
    }
    syncAll();
  }

  /** The editor calls this when its per-row scope (Format / Team type / Date)
   * changed, so the option lists reload for the new scope. */
  const onScopeChanged = () => syncAll();

  function getScopeSingletons() {
    const out = {};
    for (const f of SCOPE_STATE_FIELDS) if (f in singletons) out[f] = singletons[f];
    return out;
  }
  const getDeliveryWindow = () => singletons.deliveryWindow ?? null;
  const getOpponentPlayer = () => singletons.opponentPlayer ?? null;
  const hasAny = () => {
    const s = adapterGet();
    return SINGLETON_DEFS.some((d) => d.active(s));
  };

  return {
    SINGLETON_TYPES: POPUP_SINGLETON_TYPES,
    mountInto,
    detach,
    begin,
    isRevealed,
    revealSingleton,
    removeSingleton,
    closeOpenPanels,
    preselectPhase,
    preselectInningsNumber,
    preselectEdge,
    onScopeChanged,
    getScopeSingletons,
    getDeliveryWindow,
    getOpponentPlayer,
    hasAny,
  };
}

// One shared controller for the app's life — like the drawer, so the reused
// editors register their document-level portal listeners exactly once (the pop-up
// editor modal is created/destroyed each open, so a per-open controller would leak
// them). Only one editor modal is ever open at a time, and begin() resets the draft
// + adopts the current editor's scope/discipline on every open, so sharing is safe.
let sharedController = null;
export function getScopeSingletonsController() {
  if (!sharedController) sharedController = createScopeSingletonsController();
  return sharedController;
}
