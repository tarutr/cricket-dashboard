// src/drawer.js
//
// The "Advanced Filters" condition builder — the ONE grouped condition builder
// that is the entire second section of the Filters popup (owner task 1B-2). The
// old separate "Player" section is gone; its filters (Role / Batting hand /
// Bowling style / R. Pos.) fold in here as condition types, alongside Team
// (Played for / Against opposition), Match (Event / Venue), and the numeric
// stat conditions (split into Basic / Advanced metric groups).
//
// Shape: a "+ Add condition" grouped dropdown (optgroups: Player · Team · Match
// · Basic metrics · Advanced metrics) appends condition ROWS. Two kinds of row:
//   • SINGLETON rows (Role/Hand/Bowling/R.Pos/Team/Opposition/Event/Venue) —
//     at most one each; their value lives in its own state key (profile.* /
//     regularPositions / teams / opposition / event / venue). Built once as a
//     stable skeleton and shown/hidden by "presence" (a value is set OR the row
//     was added this popup session) so their mounted editors — option caches,
//     portal wiring — survive every numeric rebuild. An empty, never-filled
//     singleton is INACTIVE (no pill, no query effect, never blocks Search).
//   • NUMERIC rows (metric + operator + value) — write state.advanced. A numeric
//     row with a metric but no value BLOCKS Search (validate(), decision 42).
//
// Nothing here touches buildScopeClauses or the state schema — each editor just
// calls store.set(...). Profiles are men-only (decision 21): Role/Hand/Bowling
// are hidden on the Women view (R. Pos. is innings-derived, so it stays live).

import { query } from "./db.js";
import {
  regularPositionsFilterActive,
  positionsFilterActive,
  oppositionFilterActive,
  eventFilterActive,
  venueFilterActive,
  matchupVsActive,
  effectiveNamespace,
  eligibleMetrics,
} from "./state.js";
import { getMetric } from "./metrics.js";
import {
  OPERATORS,
  activeConditionCount,
  conditionHasError,
  addConditionToGroup,
  addGroup,
  removeGroup,
  setGroupOp,
  removeConditionAt,
  partitionFilterMetrics,
} from "./advanced.js";
import {
  mountRegularPositions,
  mountBattingPosition,
  mountOpposition,
  mountTeam,
  mountEvent,
  mountVenue,
} from "./drawerInnings.js";
import { escHtml, escAttr } from "./html.js";

// Display order for the profile-filter option lists.
const ROLE_GROUP_ORDER = ["Batter", "Allrounder", "Bowler"];
const ROLE_SUB_ORDER = ["Opening", "Top-order", "Middle-order", "Wicketkeeper", "Batting allrounder", "Bowling allrounder"];
const BATTING_HAND_ORDER = ["Right-hand bat", "Left-hand bat"];
const BOWLING_TYPE_ORDER = [
  "Off-spin", "Leg-spin", "Slow left-arm orthodox", "Left-arm wrist-spin",
  "Slow-medium", "Medium", "Medium-fast", "Fast-medium", "Fast",
];

function orderBy(present, order) {
  const set = new Set(present);
  const ranked = order.filter((v) => set.has(v));
  const rest = present.filter((v) => !order.includes(v)).sort();
  return [...ranked, ...rest];
}

// The singleton (non-numeric) condition types, in row/dropdown order. menOnly
// types are profile-sheet-derived → hidden on the Women view (decision 21).
const SINGLETON_TYPES = [
  { key: "role", label: "Role", group: "Player", menOnly: true },
  { key: "hand", label: "Batting hand", group: "Player", menOnly: true },
  { key: "bowling", label: "Bowling style", group: "Player", menOnly: true },
  { key: "rpos", label: "R. Pos.", group: "Player", menOnly: false },
  { key: "name", label: "Name", group: "Player", menOnly: false },
  { key: "team", label: "Played for", group: "Team", menOnly: false },
  { key: "opposition", label: "Against opposition", group: "Team", menOnly: false },
  { key: "event", label: "Event", group: "Match", menOnly: false },
  { key: "venue", label: "Venue", group: "Match", menOnly: false },
];

/**
 * Mount the condition builder into `advancedHost` (the Advanced Filters section
 * body). Returns `{ onShow, onHide, sync, activeCount, validate }` for main.js.
 */
export function mountFilterDrawer({ advancedHost }, store, { onChange }) {
  // ── Stable skeleton (built once) ───────────────────────────────────────────
  const singletonRowsHTML = SINGLETON_TYPES.map(
    (t) => `
      <div class="cond-row" data-cond="${t.key}" hidden>
        <div class="cond-row__line">
          <div class="cond-row__main">
            <span class="cond-row__type" data-role="type-label-${t.key}">${escHtml(t.label)}</span>
            <div class="cond-row__value" data-role="editor-${t.key}"></div>
          </div>
          <button type="button" class="icon-btn cond-row__remove" data-remove="${t.key}" title="Remove condition">&times;</button>
        </div>
      </div>`
  ).join("");

  // ROUND 3 (task 7): the top-level single "+ Add condition" dropdown is gone;
  // each numeric GROUP card now carries its OWN "+ Add condition" dropdown (with
  // the full taxonomy, so singletons can still be added from it) plus a Match
  // All|Any toggle, and a "+ Add group" button appends further AND groups. The
  // singleton rows stay OUTSIDE the groups.
  advancedHost.innerHTML = `
    <div class="cond-builder">
      <div class="cond-builder__rows" data-role="singleton-rows">
        ${singletonRowsHTML}
        <!-- R. Pos. and the matchup striker-position control share the R.Pos
             editor host; each self-hides in the other mode (drawerInnings.js). -->
      </div>
      <p class="cond-builder__note profile-note" data-role="women-note" hidden>Role, batting hand and bowling style filters are available for men only.</p>
      <p class="cond-builder__empty profile-note" data-role="empty-note" hidden>No filters added yet — use "Add condition" below.</p>
      <div class="cond-builder__numeric" data-role="numeric-rows"></div>
    </div>`;

  const rowEls = {};
  const typeLabelEls = {};
  const editorHosts = {};
  for (const t of SINGLETON_TYPES) {
    rowEls[t.key] = advancedHost.querySelector(`[data-cond="${t.key}"]`);
    typeLabelEls[t.key] = advancedHost.querySelector(`[data-role="type-label-${t.key}"]`);
    editorHosts[t.key] = advancedHost.querySelector(`[data-role="editor-${t.key}"]`);
  }
  const numericEl = advancedHost.querySelector('[data-role="numeric-rows"]');
  const emptyNoteEl = advancedHost.querySelector('[data-role="empty-note"]');
  const womenNoteEl = advancedHost.querySelector('[data-role="women-note"]');

  // ── Profile options + editors (men-only) ───────────────────────────────────
  let profileOptions = { roleGroups: [], subByGroup: {}, bowlingTypes: [], battingHands: [] };
  let profileOptionsLoadToken = 0;
  let profileOptionsErrored = false;

  function setProfile(patch) {
    store.set({ profile: { ...store.get().profile, ...patch } });
  }

  function selectOptionsHTML(values, selected, anyLabel) {
    const opts = [`<option value="">${escHtml(anyLabel)}</option>`];
    for (const v of values) opts.push(`<option value="${escAttr(v)}" ${v === selected ? "selected" : ""}>${escHtml(v)}</option>`);
    return opts.join("");
  }

  // Role editor: broad role + (conditional) detailed sub-role + (when the broad
  // role is "Bowler") the FINE bowling styles (ROUND 3, task 2). The fine-style
  // select writes the SAME state.profile.bowlingType as the standalone "Bowling
  // style" condition — they are two editors of one value (see report note on the
  // redundancy). renderProfileEditors keeps both in sync from profile.bowlingType.
  editorHosts.role.innerHTML = `
    <div class="profile-role">
      <select class="select" data-role="prof-roleGroup" aria-label="Playing role"></select>
      <select class="select" data-role="prof-roleSub" aria-label="Detailed role" hidden></select>
      <select class="select" data-role="prof-roleBowling" aria-label="Bowling style" hidden></select>
    </div>`;
  const roleGroupEl = editorHosts.role.querySelector('[data-role="prof-roleGroup"]');
  const roleSubEl = editorHosts.role.querySelector('[data-role="prof-roleSub"]');
  const roleBowlingEl = editorHosts.role.querySelector('[data-role="prof-roleBowling"]');
  editorHosts.hand.innerHTML = `<select class="select" data-role="prof-hand" aria-label="Batting hand"></select>`;
  const handEl = editorHosts.hand.querySelector('[data-role="prof-hand"]');
  editorHosts.bowling.innerHTML = `<select class="select" data-role="prof-bowling" aria-label="Bowling style"></select>`;
  const bowlingEl = editorHosts.bowling.querySelector('[data-role="prof-bowling"]');

  function renderProfileEditors() {
    const p = store.get().profile;
    roleGroupEl.innerHTML = selectOptionsHTML(profileOptions.roleGroups, p.roleGroup, "Any role");
    const subs = p.roleGroup ? profileOptions.subByGroup[p.roleGroup] || [] : [];
    if (subs.length > 0) {
      roleSubEl.innerHTML = selectOptionsHTML(subs, p.roleSub, "Any");
      roleSubEl.hidden = false;
    } else {
      roleSubEl.innerHTML = "";
      roleSubEl.hidden = true;
    }
    // Fine bowling styles: shown only when the broad role is "Bowler". Hiding it
    // (role changed away from Bowler) never CLEARS bowlingType — the standalone
    // "Bowling style" condition may own that value; the pill keeps it honest.
    if (p.roleGroup === "Bowler" && profileOptions.bowlingTypes.length > 0) {
      roleBowlingEl.innerHTML = selectOptionsHTML(profileOptions.bowlingTypes, p.bowlingType, "Any bowling style");
      roleBowlingEl.hidden = false;
    } else {
      roleBowlingEl.innerHTML = "";
      roleBowlingEl.hidden = true;
    }
    handEl.innerHTML = selectOptionsHTML(profileOptions.battingHands, p.battingHand, "Any");
    bowlingEl.innerHTML = selectOptionsHTML(profileOptions.bowlingTypes, p.bowlingType, "Any");
  }

  roleGroupEl.addEventListener("change", () => {
    setProfile({ roleGroup: roleGroupEl.value || null, roleSub: null });
    renderProfileEditors();
    onChange();
  });
  roleSubEl.addEventListener("change", () => {
    setProfile({ roleSub: roleSubEl.value || null });
    onChange();
  });
  roleBowlingEl.addEventListener("change", () => {
    setProfile({ bowlingType: roleBowlingEl.value || null });
    renderProfileEditors();
    onChange();
  });
  handEl.addEventListener("change", () => {
    setProfile({ battingHand: handEl.value || null });
    onChange();
  });
  bowlingEl.addEventListener("change", () => {
    setProfile({ bowlingType: bowlingEl.value || null });
    onChange();
  });

  async function loadProfileOptions() {
    const token = ++profileOptionsLoadToken;
    try {
      const [roleRows, optionRows] = await Promise.all([
        query(`SELECT DISTINCT role_group, role_subgroup FROM profiles WHERE role_group IS NOT NULL`),
        query(
          [
            `SELECT`,
            `  (SELECT list(DISTINCT bowling_type) FROM profiles WHERE bowling_type IS NOT NULL) AS bowling_types,`,
            `  (SELECT list(DISTINCT batting_style) FROM profiles WHERE batting_style IS NOT NULL) AS batting_styles`,
          ].join("\n")
        ),
      ]);
      if (token !== profileOptionsLoadToken) return;
      const groups = new Set();
      const subByGroup = {};
      for (const r of roleRows.rows) {
        groups.add(r.role_group);
        if (r.role_subgroup) (subByGroup[r.role_group] ||= []).push(r.role_subgroup);
      }
      for (const g of Object.keys(subByGroup)) subByGroup[g] = orderBy(subByGroup[g], ROLE_SUB_ORDER);
      const optRow = optionRows.rows[0] ?? {};
      profileOptions = {
        roleGroups: orderBy([...groups], ROLE_GROUP_ORDER),
        subByGroup,
        bowlingTypes: orderBy(optRow.bowling_types ?? [], BOWLING_TYPE_ORDER),
        battingHands: orderBy(optRow.batting_styles ?? [], BATTING_HAND_ORDER),
      };
      profileOptionsErrored = false;
    } catch (e) {
      if (token !== profileOptionsLoadToken) return;
      profileOptionsErrored = true;
    }
    renderProfileEditors();
  }

  // ── Editors for R.Pos / matchup position / Team / Opposition / Event / Venue ─
  // R. Pos. row hosts BOTH the plain R.Pos control and the matchup striker
  // control in two separate sub-hosts (each controller sets its own host's
  // innerHTML, so they must not share one); each self-hides in the other mode,
  // so exactly one shows and the single row covers both.
  editorHosts.rpos.innerHTML = `<div data-role="rpos-plain"></div><div data-role="rpos-matchup"></div>`;
  const regularPositionController = mountRegularPositions(
    editorHosts.rpos.querySelector('[data-role="rpos-plain"]'), store, onChange, { embedded: true }
  );
  const matchupPositionController = mountBattingPosition(
    editorHosts.rpos.querySelector('[data-role="rpos-matchup"]'), store, onChange, { embedded: true }
  );
  const teamController = mountTeam(editorHosts.team, store, onChange);
  const oppositionController = mountOpposition(editorHosts.opposition, store, onChange, { embedded: true });
  const eventController = mountEvent(editorHosts.event, store, onChange);
  const venueController = mountVenue(editorHosts.venue, store, onChange);

  // Name condition (ROUND 3, task 6): a plain text input writing state.search —
  // the existing ILIKE-on-name key the table already consumes (table.js's
  // searchClause). Empty = inactive (no pill, no query effect, never blocks
  // Search). The value is kept in sync by syncSingletonRows (guarded so it never
  // clobbers the caret while the user is typing here).
  editorHosts.name.innerHTML = `<input type="text" class="input cond-name-input" data-role="prof-name" placeholder="Player name…" aria-label="Player name" />`;
  const nameEl = editorHosts.name.querySelector('[data-role="prof-name"]');
  nameEl.addEventListener("input", () => {
    store.set({ search: nameEl.value });
    onChange();
  });

  // ── Presence + session-added tracking ──────────────────────────────────────
  // sessionAdded: singleton rows the user added THIS popup session that don't
  // yet carry a value. Reset on every popup open (onShow) so never-filled rows
  // don't linger — presence then re-derives purely from state values.
  const sessionAdded = {};

  function hasValue(key, s) {
    switch (key) {
      case "role": return Boolean(s.profile.roleGroup);
      case "hand": return Boolean(s.profile.battingHand);
      case "bowling": return Boolean(s.profile.bowlingType);
      case "rpos": return (s.regularPositions || []).length > 0 || (s.positions || []).length > 0;
      case "name": return Boolean((s.search || "").trim());
      case "team": return (s.teams || []).length > 0;
      case "opposition": return (s.opposition || []).length > 0;
      case "event": return (s.event || []).length > 0;
      case "venue": return (s.venue || []).length > 0;
      default: return false;
    }
  }

  function isPresent(t, s) {
    if (t.menOnly && s.gender === "female") return false;
    return hasValue(t.key, s) || Boolean(sessionAdded[t.key]);
  }

  function clearSingleton(key) {
    switch (key) {
      case "role": setProfile({ roleGroup: null, roleSub: null }); break;
      case "hand": setProfile({ battingHand: null }); break;
      case "bowling": setProfile({ bowlingType: null }); break;
      case "rpos": store.set({ regularPositions: [], positions: [] }); break;
      case "name": store.set({ search: "" }); break;
      case "team": store.set({ teams: [] }); break;
      case "opposition": store.set({ opposition: [] }); break;
      case "event": store.set({ event: [] }); break;
      case "venue": store.set({ venue: [] }); break;
    }
  }

  // Remove-× on each singleton row.
  for (const t of SINGLETON_TYPES) {
    rowEls[t.key].querySelector(`[data-remove="${t.key}"]`).addEventListener("click", () => {
      sessionAdded[t.key] = false;
      clearSingleton(t.key);
      syncSingletonRows();
      onChange();
    });
  }

  // ── "+ Add condition" dropdown (rendered inside EACH numeric group) ────────
  // ROUND 3 (tasks 3 + 7): the single top-level add dropdown is gone; each
  // numeric GROUP card carries its own "+ Add condition" <select> (data-gi), so
  // a metric is added to THAT group. It keeps the full taxonomy — Player · Team ·
  // Match · Dismissal type · Basic metrics · Advanced metrics — so singletons
  // can still be added from it (they attach to the shared singleton rows above,
  // OUTSIDE every group). "Dismissal type" (task 3) sits between Match and Basic
  // metrics and holds the dismissal COUNT metrics moved out of Advanced.
  function metricLabel(metricKey, ns) {
    const m = getMetric(metricKey, ns) || getMetric(metricKey);
    return m ? m.label : metricKey;
  }

  // Display-only override for the "+ Add condition…" dropdown OPTION label
  // (R4 Wave 1a, owner decision): "R. Pos." reads as jargon in that menu.
  // Everything else that shows this condition type — the row's own type label
  // (syncSingletonRows sets it to "R. Pos." / "Batting position"), pills, and
  // the metric label elsewhere — is untouched; SINGLETON_TYPES.rpos.label
  // ("R. Pos.") stays as-is and still drives those. Scoped to this one builder
  // function rather than renaming the shared type label globally.
  const ADD_CONDITION_LABEL_OVERRIDES = { rpos: "Regular position" };

  function addSelectOptionsHTML(s) {
    const ns = effectiveNamespace(s);
    const women = s.gender === "female";
    // R. Pos. (kind:"position") is a position-MODE value, not a numeric
    // quantity, so it can never be a numeric stat-condition (table.js's
    // conditionApplicability already drops it silently). Exclude position-kind
    // metrics from the "+ Add condition…" numeric lists so it never appears as
    // an addable numeric condition. The R.Pos FILTER is unaffected — that's the
    // separate "Regular position" Player-group singleton (c:rpos, the
    // modal-position editor from commit e71530d), still listed via groupOpts.
    const numericMetrics = eligibleMetrics(ns, s.formats).filter((m) => m.kind !== "position");
    const { basic, dismissal, advanced } = partitionFilterMetrics(numericMetrics);
    // A singleton already showing is disabled in every group's dropdown (at most
    // one each); presence re-enables it the moment its row is removed.
    const present = SINGLETON_TYPES.filter((t) => isPresent(t, s)).map((t) => t.key);
    const groupOpts = (groupName) =>
      SINGLETON_TYPES.filter((t) => t.group === groupName && !(t.menOnly && women))
        .map(
          (t) =>
            `<option value="c:${t.key}"${present.includes(t.key) ? " disabled" : ""}>${escHtml(
              ADD_CONDITION_LABEL_OVERRIDES[t.key] || t.label
            )}</option>`
        )
        .join("");
    const metricOpts = (list) => list.map((m) => `<option value="m:${escAttr(m.key)}">${escHtml(m.label)}</option>`).join("");
    return `
      <option value="">+ Add condition…</option>
      <optgroup label="Player">${groupOpts("Player")}</optgroup>
      <optgroup label="Team">${groupOpts("Team")}</optgroup>
      <optgroup label="Match">${groupOpts("Match")}</optgroup>
      ${dismissal.length ? `<optgroup label="Dismissal type">${metricOpts(dismissal)}</optgroup>` : ""}
      ${basic.length ? `<optgroup label="Basic metrics">${metricOpts(basic)}</optgroup>` : ""}
      ${advanced.length ? `<optgroup label="Advanced metrics">${metricOpts(advanced)}</optgroup>` : ""}`;
  }

  // ── Singleton rows: show/hide + editor sync ─────────────────────────────────
  function syncSingletonRows() {
    const s = store.get();
    const women = s.gender === "female";
    for (const t of SINGLETON_TYPES) {
      rowEls[t.key].hidden = !isPresent(t, s);
    }
    // R. Pos. row label reflects which control is live (plain vs matchup).
    typeLabelEls.rpos.textContent = matchupVsActive(s) ? "Batting position" : "R. Pos.";
    womenNoteEl.hidden = !women;

    regularPositionController.sync();
    matchupPositionController.sync();
    teamController.sync();
    oppositionController.sync();
    eventController.sync();
    venueController.sync();
    // Keep the Name input in sync without clobbering the caret while typing here.
    if (document.activeElement !== nameEl) nameEl.value = s.search || "";
    renderProfileEditors();
    updateEmptyNote(s);
  }

  // ── Numeric condition GROUPS (multi-group AND/OR — ROUND 3 task 7) ──────────
  // Rebuilt only when the STRUCTURE changes (group count / per-group op / metric
  // / operator / eligible-metric vocabulary / singleton presence), never on a
  // value keystroke — otherwise the input being typed into would be destroyed,
  // dropping focus and caret. `force` bypasses the key skip.
  let lastNumericKey = null;
  let showErrors = false;

  /** Groups to RENDER: a synthetic empty group 0 stands in when state has none
   * yet, so there's always exactly one group card whose "+ Add condition"
   * dropdown is the entry point. addConditionToGroup materialises it on the
   * first metric add; before that, singletons added from it need no group. */
  function renderGroups(s) {
    const g = s.advanced.groups || [];
    return g.length ? g : [{ op: "AND", conds: [] }];
  }
  function realGroups(s) {
    return s.advanced.groups || [];
  }
  function totalNumericConds(s) {
    return realGroups(s).reduce((n, g) => n + g.conds.length, 0);
  }

  function structuralKey(s) {
    return JSON.stringify({
      ns: effectiveNamespace(s),
      women: s.gender === "female",
      present: SINGLETON_TYPES.filter((t) => isPresent(t, s)).map((t) => t.key),
      formats: s.formats,
      groups: renderGroups(s).map((g) => ({ op: g.op, conds: g.conds.map((c) => `${c.metricKey}|${c.operator}`) })),
      errors: showErrors,
    });
  }

  function conditionRowHTML(cond, gi, ci, ns) {
    const hasError = showErrors && conditionHasError(cond);
    const valueFields =
      cond.operator === "between"
        ? `<input type="number" class="input cond-row__value-input" data-role="v1" value="${escAttr(cond.v1)}" placeholder="min" />
           <span class="cond-row__and">and</span>
           <input type="number" class="input cond-row__value-input" data-role="v2" value="${escAttr(cond.v2)}" placeholder="max" />`
        : `<input type="number" class="input cond-row__value-input" data-role="v1" value="${escAttr(cond.v1)}" placeholder="value" />`;
    return `
      <div class="cond-row cond-row--metric ${hasError ? "cond-row--error" : ""}" data-gi="${gi}" data-ci="${ci}">
        <div class="cond-row__line">
          <div class="cond-row__main">
            <span class="cond-row__type">${escHtml(metricLabel(cond.metricKey, ns))}</span>
            <select class="select" data-role="operator">
              ${OPERATORS.map((o) => `<option value="${o.key}" ${cond.operator === o.key ? "selected" : ""}>${o.label}</option>`).join("")}
            </select>
            ${valueFields}
          </div>
          <button type="button" class="icon-btn cond-row__remove" data-role="remove-metric" title="Remove condition">&times;</button>
        </div>
        ${hasError ? `<p class="cond-row__error" data-role="cond-error">Enter a value or remove this condition</p>` : ""}
      </div>`;
  }

  function groupCardHTML(g, gi, ns, s, multi) {
    // The Match All|Any toggle shows once a group has ≥2 conditions (where it's
    // meaningful) OR once there are multiple groups (so every group carries its
    // own toggle, per task 7). A lone single-condition group still looks like
    // the pre-ROUND-3 one row. "Remove group" shows only when >1 group exists.
    const showOp = multi || g.conds.length >= 2;
    const removeBtn = multi
      ? `<button type="button" class="link-btn cond-group__remove" data-role="remove-group" data-gi="${gi}">Remove group</button>`
      : "";
    const opControl = showOp
      ? `<span class="cond-group__match">Match</span>
         <div class="segmented segmented--small" data-role="group-op" data-gi="${gi}">
           <button type="button" class="segmented__btn ${g.op !== "OR" ? "is-active" : ""}" data-value="AND">All</button>
           <button type="button" class="segmented__btn ${g.op === "OR" ? "is-active" : ""}" data-value="OR">Any</button>
         </div>
         <span class="cond-group__match">of</span>`
      : "";
    const head = showOp || removeBtn ? `<div class="cond-group__head">${opControl}${removeBtn}</div>` : "";
    const rows = g.conds.map((c, ci) => conditionRowHTML(c, gi, ci, ns)).join("");
    return `
      <div class="cond-group${multi ? " is-multi" : ""}" data-gi="${gi}">
        ${head}
        <div class="cond-group__rows">${rows}</div>
        <div class="cond-group__add">
          <select class="select cond-builder__add-select" data-role="add-cond" data-gi="${gi}" aria-label="Add a filter condition">${addSelectOptionsHTML(s)}</select>
        </div>
      </div>`;
  }

  function updateEmptyNote(s) {
    const anySingleton = SINGLETON_TYPES.some((t) => isPresent(t, s));
    emptyNoteEl.hidden = anySingleton || totalNumericConds(s) > 0;
  }

  function renderNumeric(s, force = false) {
    const ns = effectiveNamespace(s);
    const key = structuralKey(s);
    if (!force && key === lastNumericKey) {
      updateEmptyNote(s);
      return;
    }
    lastNumericKey = key;
    const groups = renderGroups(s);
    const multi = groups.length > 1;
    const connector = `<div class="cond-group__connector">and</div>`;
    const cards = groups.map((g, gi) => (gi > 0 ? connector : "") + groupCardHTML(g, gi, ns, s, multi)).join("");
    // "+ Add group" appears once at least one numeric condition exists (adding
    // empty groups before the first condition would be pointless). Groups
    // AND-combine (advanced.op stays "AND") exactly as advancedToHaving renders.
    const addGroupBtn =
      totalNumericConds(s) >= 1
        ? `<button type="button" class="text-btn text-btn--add-group" data-role="add-group">+ Add group</button>`
        : "";
    numericEl.innerHTML = cards + addGroupBtn;
    wireNumeric();
    updateEmptyNote(s);
  }

  function wireNumeric() {
    const groups = realGroups(store.get());

    // Per-group "+ Add condition" dropdowns (singleton OR metric, by data-gi).
    numericEl.querySelectorAll('[data-role="add-cond"]').forEach((sel) => {
      sel.addEventListener("change", () => {
        const gi = Number(sel.dataset.gi);
        const v = sel.value;
        sel.value = "";
        if (!v) return;
        if (v.startsWith("c:")) {
          sessionAdded[v.slice(2)] = true;
          syncSingletonRows();
          renderNumeric(store.get(), true); // refresh disabled states in every group's dropdown
          onChange();
        } else if (v.startsWith("m:")) {
          addConditionToGroup(store, gi, v.slice(2));
          renderNumeric(store.get(), true);
          // Focus the freshly-added row's value input within its own group.
          const groupEl = numericEl.querySelector(`.cond-group[data-gi="${gi}"]`);
          const inputs = (groupEl || numericEl).querySelectorAll('.cond-row--metric [data-role="v1"]');
          if (inputs.length) inputs[inputs.length - 1].focus();
          onChange();
        }
      });
    });

    // Per-group Match All|Any toggle (writes group.op "AND"/"OR").
    numericEl.querySelectorAll('[data-role="group-op"]').forEach((seg) => {
      const gi = Number(seg.dataset.gi);
      seg.querySelectorAll(".segmented__btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          setGroupOp(store, gi, btn.dataset.value);
          renderNumeric(store.get(), true);
          onChange();
        });
      });
    });

    // Per-group "Remove group".
    numericEl.querySelectorAll('[data-role="remove-group"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        removeGroup(store, Number(btn.dataset.gi));
        renderNumeric(store.get(), true);
        syncSingletonRows(); // empty-note may change
        onChange();
      });
    });

    // "+ Add group".
    const addGroupBtn = numericEl.querySelector('[data-role="add-group"]');
    if (addGroupBtn) {
      addGroupBtn.addEventListener("click", () => {
        addGroup(store);
        renderNumeric(store.get(), true);
        onChange();
      });
    }

    // Condition rows (operator / value / remove), addressed by group + index.
    numericEl.querySelectorAll(".cond-row--metric").forEach((rowEl) => {
      const gi = Number(rowEl.dataset.gi);
      const ci = Number(rowEl.dataset.ci);
      const group = groups[gi];
      const cond = group && group.conds[ci];
      if (!cond) return;

      const opSel = rowEl.querySelector('[data-role="operator"]');
      opSel.addEventListener("change", () => {
        const wasBetween = cond.operator === "between";
        cond.operator = opSel.value;
        store.set({ advanced: { ...store.get().advanced } });
        if (wasBetween !== (cond.operator === "between")) renderNumeric(store.get(), true);
        onChange();
      });

      rowEl.querySelectorAll('[data-role="v1"],[data-role="v2"]').forEach((input) => {
        input.addEventListener("input", () => {
          cond[input.dataset.role] = input.value;
          store.set({ advanced: { ...store.get().advanced } });
          // Live-clear this row's validation error the instant it's fixed —
          // without a full rebuild (which would drop focus/caret mid-keystroke).
          if (showErrors && !conditionHasError(cond)) {
            rowEl.classList.remove("cond-row--error");
            const msg = rowEl.querySelector('[data-role="cond-error"]');
            if (msg) msg.remove();
          }
        });
        input.addEventListener("change", () => onChange());
      });

      rowEl.querySelector('[data-role="remove-metric"]').addEventListener("click", () => {
        removeConditionAt(store, gi, ci);
        renderNumeric(store.get(), true);
        syncSingletonRows(); // empty-note may change
        onChange();
      });
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  /** decision 42: numeric conditions with a value missing block Search with an
   * inline per-row message. Singleton conditions never block (empty = inactive). */
  function validate() {
    const hasErrors = (store.get().advanced.groups || []).some((g) => g.conds.some(conditionHasError));
    showErrors = hasErrors;
    if (!hasErrors) return true;
    renderNumeric(store.get(), true);
    const firstBad = numericEl.querySelector('.cond-row--error [data-role="v1"]');
    if (firstBad) firstBad.focus();
    return false;
  }

  let advancedSnapshotAtOpen = null;

  function onShow() {
    // Never-filled singleton rows from a previous session shouldn't linger:
    // reset the session flags so presence re-derives purely from state values.
    for (const k of Object.keys(sessionAdded)) sessionAdded[k] = false;
    advancedSnapshotAtOpen = JSON.stringify(store.get().advanced);
    showErrors = false;
    sync();
    if (profileOptionsErrored) loadProfileOptions();
  }

  function onHide() {
    if (advancedSnapshotAtOpen !== null) {
      const changed = JSON.stringify(store.get().advanced) !== advancedSnapshotAtOpen;
      advancedSnapshotAtOpen = null;
      if (changed) onChange();
    }
  }

  function sync() {
    const s = store.get();
    syncSingletonRows();
    renderNumeric(s);
  }

  /** Badge count: only filters ACTUALLY applied right now (inert selections
   * don't count, matching the pills). */
  function activeCount() {
    const s = store.get();
    let n = 0;
    if ((s.teams || []).length > 0) n++;
    if (s.gender !== "female") {
      const p = s.profile;
      if (p.roleGroup) n++;
      if (p.roleSub) n++;
      if (p.battingHand) n++;
      if (p.bowlingType) n++;
    }
    if (positionsFilterActive(s)) n++;
    if (regularPositionsFilterActive(s)) n++;
    if (oppositionFilterActive(s)) n++;
    if (eventFilterActive(s)) n++;
    if (venueFilterActive(s)) n++;
    n += activeConditionCount(s.advanced);
    return n;
  }

  loadProfileOptions();
  sync();

  return { onShow, onHide, sync, activeCount, validate };
}
