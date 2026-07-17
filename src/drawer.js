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
import { getMetric, matchupBucketLabel } from "./metrics.js";
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

// The singleton (non-numeric) condition types. menOnly types are profile-sheet-
// derived → hidden on the Women view (decision 21). R5 Wave 1a (item 7)
// restructured the "+ Add condition" dropdown: the old standalone "Team" subset
// is dissolved into "Player" (Played for → "Team", Against opposition →
// "Opposition"); Bowling style is no longer a standalone dropdown entry (it is
// reachable via Role → Bowler, which exposes the fine bowling styles and writes
// the SAME profile.bowlingType); and R. Pos. relocates into the Basic-metrics
// group after "Innings". The DROPDOWN order/grouping is driven by the explicit
// order arrays in addSelectOptionsHTML below (not by this array's order or the
// `group` field, which is now documentation only). This array's order drives the
// applied-ROW render order in the singleton-rows container.
const SINGLETON_TYPES = [
  { key: "team", label: "Team", group: "Player", menOnly: false },
  { key: "opposition", label: "Opposition", group: "Player", menOnly: false },
  { key: "hand", label: "Batting hand", group: "Player", menOnly: true },
  { key: "bowling", label: "Bowling style", group: "Player", menOnly: true },
  { key: "role", label: "Role", group: "Player", menOnly: true },
  // "Vs" (R3.2): the matchup opponent selector, mirroring the toolbar's bonded
  // Vs control — both edit state.matchupVs, synced via the shared store. Injected
  // into the Basic-metrics dropdown group right after "Innings" (see basicOpts).
  // Men-only (matchupVsActive hard-gates on male; coverage is ~0% for women).
  { key: "vs", label: "Vs", group: "Basic", menOnly: true },
  { key: "rpos", label: "R. Pos.", group: "Basic", menOnly: false },
  { key: "event", label: "Event", group: "Match", menOnly: false },
  { key: "venue", label: "Venue", group: "Match", menOnly: false },
];

// Dropdown OPTION order per group (R5 Wave 1a, item 7; "bowling" re-added R5
// Wave 2 per owner — his Player list omitted it only because he was thinking of
// batting filters). "rpos" is injected into the Basic-metrics optgroup right
// after "Innings".
const PLAYER_ADD_ORDER = ["team", "opposition", "hand", "bowling", "role"];
const MATCH_ADD_ORDER = ["event", "venue"];

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

  // ── "Vs" matchup editor (R3.2) ──────────────────────────────────────────────
  // Mirrors the results-toolbar's bonded Vs control — both edit state.matchupVs,
  // kept in sync purely through the shared store (a change here calls onChange →
  // main.js re-syncs the toolbar; a toolbar change re-syncs this via sync()).
  // buildMatchupQuery is untouched. Options depend on discipline (batting →
  // pace/spin group + fine bowling types; bowling → batting hand) and match the
  // toolbar's set — the fine bowling types come from the SAME matchup_batting
  // distinct-values query, so any value set on either side displays on the other.
  editorHosts.vs.innerHTML = `<select class="select" data-role="cond-vs" aria-label="Matchup opponent"></select>`;
  const vsEl = editorHosts.vs.querySelector('[data-role="cond-vs"]');
  let vsBowlingTypes = null; // fetched once; null until loaded (Vs disabled/coarse-only until then)
  async function loadVsBowlingTypes() {
    if (vsBowlingTypes) return vsBowlingTypes;
    try {
      const { rows } = await query(
        `SELECT DISTINCT bowling_type AS v FROM matchup_batting WHERE bowling_type <> '(unmapped)'`
      );
      const vals = rows.map((r) => r.v);
      // Same ordering intent as the toolbar's orderBowlingTypes: named fine
      // styles first, then any unlisted style alphabetically, then the bare
      // Pace/Spin buckets last (they read as "…(unspecified)" via matchupBucketLabel).
      const set = new Set(vals);
      const known = BOWLING_TYPE_ORDER.filter((v) => set.has(v));
      const knownSet = new Set(known);
      const buckets = ["Pace", "Spin"].filter((v) => set.has(v));
      const bucketSet = new Set(buckets);
      const rest = vals.filter((v) => !knownSet.has(v) && !bucketSet.has(v)).sort();
      vsBowlingTypes = [...known, ...rest, ...buckets];
    } catch (e) {
      vsBowlingTypes = null; // leave null so a later render retries
      return [];
    }
    return vsBowlingTypes;
  }
  vsEl.addEventListener("change", () => {
    const raw = vsEl.value;
    if (!raw) {
      store.set({ matchupVs: null });
    } else {
      const i = raw.indexOf(":");
      store.set({ matchupVs: { dim: raw.slice(0, i), value: raw.slice(i + 1) } });
    }
    onChange();
  });
  function renderVsEditor() {
    const s = store.get();
    // Fetch the fine bowling types on demand for the batting view; re-render
    // once they arrive so a fine "type:…" value shows selected rather than
    // falling back to "Everyone".
    if (s.discipline === "batting" && !vsBowlingTypes) {
      loadVsBowlingTypes().then(() => renderVsEditor());
    }
    const current = matchupVsActive(s) ? `${s.matchupVs.dim}:${s.matchupVs.value}` : "";
    const opt = (value, label) =>
      `<option value="${escAttr(value)}" ${value === current ? "selected" : ""}>${escHtml(label)}</option>`;
    if (s.discipline === "batting") {
      const typeOpts = (vsBowlingTypes || []).map((t) => opt(`type:${t}`, matchupBucketLabel(t))).join("");
      vsEl.innerHTML = `${opt("", "Everyone")}
        <optgroup label="Pace / spin">${opt("group:Pace", "Pace")}${opt("group:Spin", "Spin")}</optgroup>
        <optgroup label="Bowling type">${typeOpts}</optgroup>`;
    } else {
      vsEl.innerHTML = `${opt("", "Everyone")}${opt("hand:Right-hand bat", "Right-handers")}${opt(
        "hand:Left-hand bat",
        "Left-handers"
      )}`;
    }
  }

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
      case "vs": return matchupVsActive(s); // present iff a Vs bucket applies to the current discipline
      case "rpos": return (s.regularPositions || []).length > 0 || (s.positions || []).length > 0;
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
      case "vs": store.set({ matchupVs: null }); break;
      case "rpos": store.set({ regularPositions: [], positions: [] }); break;
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
  // (R4 Wave 1a; relabelled again R7 Wave B item 6 → "Reg. Batting Position"):
  // "R. Pos." reads as jargon in that menu. Everything else that shows this
  // condition type — the row's own type label (syncSingletonRows sets it to
  // "R. Pos." / "Batting position"), pills, and the metric label elsewhere — is
  // untouched; SINGLETON_TYPES.rpos.label ("R. Pos.") stays as-is and still
  // drives those. Scoped to this one builder function rather than renaming the
  // shared type label globally.
  const ADD_CONDITION_LABEL_OVERRIDES = { rpos: "Reg. Batting Position" };

  // Dismissal-type dropdown labels drop the leading "Out " (R5 Wave 1a, item 7:
  // "Caught" not "Out Caught"). Display-only — the metric KEYS/labels in
  // metrics.js are untouched; this strips the prefix at render time only. The
  // bowling wkt_* labels have no "Out " prefix, so this is a no-op for them.
  const stripOutPrefix = (label) => label.replace(/^Out\s+/, "");

  function addSelectOptionsHTML(s) {
    const ns = effectiveNamespace(s);
    const women = s.gender === "female";
    // R. Pos. (kind:"position") is a position-MODE value, not a numeric
    // quantity, so it can never be a numeric stat-condition (table.js's
    // conditionApplicability already drops it silently). Exclude position-kind
    // metrics from the "+ Add condition…" numeric lists so it never appears as
    // an addable numeric condition. The R.Pos FILTER is unaffected — that's the
    // separate "Regular position" singleton (c:rpos, the modal-position editor),
    // injected into the Basic-metrics group after "Innings" below.
    const numericMetrics = eligibleMetrics(ns, s.formats).filter((m) => m.kind !== "position");
    const { basic, dismissal, advanced } = partitionFilterMetrics(numericMetrics);
    // A singleton already showing is disabled in every group's dropdown (at most
    // one each); presence re-enables it the moment its row is removed.
    const present = SINGLETON_TYPES.filter((t) => isPresent(t, s)).map((t) => t.key);
    const singletonOpt = (key) => {
      const t = SINGLETON_TYPES.find((x) => x.key === key);
      if (!t || (t.menOnly && women)) return "";
      return `<option value="c:${t.key}"${present.includes(t.key) ? " disabled" : ""}>${escHtml(
        ADD_CONDITION_LABEL_OVERRIDES[t.key] || t.label
      )}</option>`;
    };
    const singletonOpts = (order) => order.map(singletonOpt).join("");
    const metricOpt = (m, label) => `<option value="m:${escAttr(m.key)}">${escHtml(label ?? m.label)}</option>`;
    const metricOpts = (list) => list.map((m) => metricOpt(m)).join("");
    // Basic metrics group: standard metric options, with the "Regular position"
    // singleton (c:rpos) injected right after the "Innings" option (item 7).
    // BATTING ONLY (R3.1 task 2): R. Pos. (state.regularPositions) is a batting
    // concept — a player's own regular BATTING position — so it must not be
    // addable while the plain discipline is bowling. Matchup mode is untouched:
    // matchupVsActive keeps c:rpos available there under its "Batting position"
    // label for BOTH matchup_batting (batter's own position) and matchup_bowling
    // (the STRIKER's position faced, decision 46, anchor-verified) — an
    // orthogonal, already-shipped feature this gate must not disturb.
    const basicOpts = () => {
      const rposEligible = s.discipline === "batting" || matchupVsActive(s);
      const rposOpt = rposEligible ? singletonOpt("rpos") : "";
      // "Vs" (R3.2): injected right AFTER Innings, before R. Pos. Available in
      // both disciplines (batting → pace/spin/type; bowling → hand); singletonOpt
      // returns "" for women (menOnly) and disables it once the row is present.
      const vsOpt = singletonOpt("vs");
      const parts = [];
      let injected = false;
      for (const m of basic) {
        parts.push(metricOpt(m));
        if (m.key === "innings") {
          parts.push(vsOpt);
          parts.push(rposOpt);
          injected = true;
        }
      }
      if (!injected) { // no Innings option (edge) — append
        parts.push(vsOpt);
        parts.push(rposOpt);
      }
      return parts.join("");
    };
    const dismissalOpts = dismissal.map((m) => metricOpt(m, stripOutPrefix(m.label))).join("");
    return `
      <option value="">+ Add condition…</option>
      <optgroup label="Player">${singletonOpts(PLAYER_ADD_ORDER)}</optgroup>
      <optgroup label="Match">${singletonOpts(MATCH_ADD_ORDER)}</optgroup>
      <optgroup label="Basic metrics">${basicOpts()}</optgroup>
      ${advanced.length ? `<optgroup label="Advanced metrics">${metricOpts(advanced)}</optgroup>` : ""}
      ${dismissal.length ? `<optgroup label="Dismissal type">${dismissalOpts}</optgroup>` : ""}`;
  }

  // ── Singleton rows: show/hide + editor sync ─────────────────────────────────
  function syncSingletonRows() {
    const s = store.get();
    for (const t of SINGLETON_TYPES) {
      rowEls[t.key].hidden = !isPresent(t, s);
    }
    // R. Pos. row label reflects which control is live (plain vs matchup).
    typeLabelEls.rpos.textContent = matchupVsActive(s) ? "Batting position" : "R. Pos.";

    renderVsEditor();
    regularPositionController.sync();
    matchupPositionController.sync();
    teamController.sync();
    oppositionController.sync();
    eventController.sync();
    venueController.sync();
    renderProfileEditors();
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

  function renderNumeric(s, force = false) {
    const ns = effectiveNamespace(s);
    const key = structuralKey(s);
    if (!force && key === lastNumericKey) {
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
   * don't count, matching the pills). `stateOverride` (R7 Wave B item 4) lets
   * main.js count the APPLIED snapshot rather than the live store, so pending
   * popup edits don't bump the toolbar badge before Search — the badge and the
   * pills then agree on the same applied state. Defaults to the live store for
   * any other caller. */
  function activeCount(stateOverride) {
    const s = stateOverride || store.get();
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
