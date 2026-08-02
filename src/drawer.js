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
  fieldingPositionActive,
  fieldingKindActive,
  fieldingPhaseActive,
  resultFilterActive,
  tossResultFilterActive,
  tossDecisionFilterActive,
  inningsOrderFilterActive,
  stageFilterActive,
  resultConditionFilterActive,
  matchupVsActive,
  effectiveNamespace,
  eligibleMetrics,
  FIELDING_KIND_OPTIONS,
  FIELDING_POSITIONS,
} from "./state.js";
import { deliveryWindowTokens, withDeliveryWindowPiece } from "./deliveryWindow.js";
import { ballEngineEnabled } from "./config.js";
import { getMetric, matchupBucketLabel, metricDisplayLabel } from "./metrics.js";
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
  isBowlingFiguresCondition,
} from "./advanced.js";
import {
  mountRegularPositions,
  mountBattingPosition,
  mountOpposition,
  mountTeam,
  mountEvent,
  mountVenue,
  mountFieldingPosition,
  mountFieldingKind,
  mountFieldingPhase,
  mountResult,
  mountTossResult,
  mountTossDecision,
  mountInningsOrder,
  mountStage,
  mountWindowPhase,
  mountWindowOvers,
  mountWindowBalls,
  mountWindowPlayer,
  windowPhaseBallsAllowed,
} from "./drawerInnings.js";
import { mountSearchSelect } from "./searchSelect.js";
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
  // Delivery window (ball-grain rebuild Wave 3, owner decision 67; UI-A REWORK
  // 2026-07-31): FOUR separate, freely-composing "+ Add condition" entries — Phase,
  // Over range, Ball range, Player balls — replacing the old single combined
  // control (the owner ruled a Phase|Overs|Balls mode-TOGGLE a deprecated style
  // that forces one mode). Each writes/reads its OWN piece of state.deliveryWindow
  // and carries its own removable pill. `ballOnly` means each exists ONLY while the
  // ball engine is active (a window can't apply to the pre-summed innings parquet)
  // — isPresent hard-gates them off flag-OFF and the add-dropdown omits them there,
  // so with the flag OFF the app is byte-untouched. Phase / Ball range are further
  // gated to a single T20 / 50-over bucket (windowPhaseBallsAllowed); Over range +
  // Player balls apply in every format. They lead the array so their applied rows
  // render first among the singleton rows, grouped under the "Delivery" optgroup.
  { key: "win_phase", label: "Phase", group: "Delivery", menOnly: false, ballOnly: true },
  { key: "win_overs", label: "Over range", group: "Delivery", menOnly: false, ballOnly: true },
  { key: "win_balls", label: "Ball range", group: "Delivery", menOnly: false, ballOnly: true },
  { key: "win_player", label: "Player balls", group: "Delivery", menOnly: false, ballOnly: true },
  // "Matchup (Vs)" (R3.2; relabelled Wave A1 item 1; R5-A #5 moved it to the
  // FIRST entry INSIDE the "Advanced metrics" optgroup, directly above Dot Ball
  // %): the matchup opponent selector, mirroring the toolbar's bonded Vs control
  // — both edit state.matchupVs, synced via the shared store (see
  // addSelectOptionsHTML). Leads this array too, so its applied row renders
  // first among the singleton rows (SINGLETON_TYPES order also drives applied-row
  // order). Men-only (matchupVsActive hard-gates on male; coverage is ~0% for women).
  { key: "vs", label: "Matchup (Vs)", group: "Basic", menOnly: true },
  { key: "team", label: "Team", group: "Player", menOnly: false },
  { key: "opposition", label: "Opposition", group: "Player", menOnly: false },
  { key: "hand", label: "Batting hand", group: "Player", menOnly: true },
  { key: "bowling", label: "Bowling style", group: "Player", menOnly: true },
  { key: "role", label: "Role", group: "Player", menOnly: true },
  { key: "rpos", label: "R. Pos.", group: "Basic", menOnly: false },
  // Striker "Batting position" (R5-A #8): the MATCHUP-ONLY ball-level filter on
  // the batter-faced position (state.positions) — the one that powers the Bumrah-
  // vs-openers anchor. Split OUT of the R. Pos. row so it never auto-appears when
  // a Vs bucket is picked; its OWN addable "+ Add condition" entry, offered only
  // in matchup mode (isPresent gates it on matchupVsActive). Men-only in practice
  // (matchup coverage ~0% for women; matchupVsActive hard-gates on male anyway).
  { key: "strikerpos", label: "Batting position", group: "Basic", menOnly: true },
  { key: "event", label: "Event", group: "Match", menOnly: false },
  // Stage (tournament round) moved OUT of the "Match context" group into "Match",
  // directly under Event and above Venue (owner, polish item 3) — it is a property
  // of the competition you are already picking, and its options now cross-filter by
  // the selected Event(s). Its position here also drives the APPLIED-row order, so
  // the Stage row renders next to the Event row it belongs with.
  { key: "mc_stage", label: "Stage", group: "Match", menOnly: false },
  { key: "venue", label: "Venue", group: "Match", menOnly: false },
  // Fielding SLICE conditions (fielding rebuild): the fielding metric's OWN dims
  // — narrow WHICH wicket-events the Catches/Stumpings/Run-outs/Dismissals-
  // Effected columns count. PLAIN mode only (fielding has no matchup grain);
  // isPresent gates them on !matchupVsActive. Not menOnly — fielding works for
  // both genders. They sit in the "Fielding" dropdown optgroup, alongside the
  // fielding metric conditions.
  { key: "fld_pos", label: "Dismissed position", group: "Fielding", menOnly: false },
  { key: "fld_kind", label: "Dismissal kind", group: "Fielding", menOnly: false },
  { key: "fld_phase", label: "Fielding phase", group: "Fielding", menOnly: false },
  // Match-context singletons (Wave 6): categorical WHERE filters keyed off the
  // MATCH's context. Both genders; work in batting, bowling AND matchup views
  // (no matchup gate), so — unlike the fielding slices — isPresent has no Vs
  // carve-out for them. They write their own top-level state key (result /
  // tossResult / tossDecision / inningsOrder / stage). The former standalone
  // "Rain-affected matches" (mc_method) is gone — its method logic now lives in
  // the Result Condition sub-picker NESTED inside Result (state.resultCondition,
  // FIX B / polish item 4). Stage has moved up into the "Match" group (see above).
  { key: "mc_result", label: "Result", group: "Match context", menOnly: false },
  { key: "mc_toss_result", label: "Toss result", group: "Match context", menOnly: false },
  { key: "mc_toss_decision", label: "Toss decision", group: "Match context", menOnly: false },
  { key: "mc_innings_order", label: "Innings order", group: "Match context", menOnly: false },
];

// (The old per-group option-ORDER arrays — PLAYER_ADD_ORDER / MATCH_ADD_ORDER /
// FIELDING_SLICE_ADD_ORDER / MATCH_CONTEXT_ADD_ORDER — drove the native <select>'s
// optgroups and were retired with it in Wave R2: the search palette's order now
// lives in buildPaletteGroups' explicit 7-group taxonomy.)

// ── Filter-rejig Wave R2: metrics DELETED from the "+ Add condition" PICKER ──
// Display-only removal from the filter list (decision 68 / filter-rejig-spec.md
// "Deletes"). The metric DEFINITIONS + columns + data STAY in metrics.js — these
// keys are only withheld from buildPaletteGroups' offered leaves, so the query
// builders are untouched (numbers sacred). Cut ONLY for genuine redundancy /
// owner-cut, never for niche:
//   • ALL per-phase metrics (Powerplay/Middle/Death SR/Econ/Wkts + ODI variants,
//     batting + bowling) — subsumed by Ball Ranges: Phase + the base metric.
//     Caught generically by `isPhaseMetric` truthy, so no key list can drift.
//   • Progression SR (first-10 / 11–20 / 21+) — subsumed by Batter/Bowler Ball
//     Range + Strike Rate.
//   • Wickets per Innings, Not Out % — owner cuts. Dismissals Effected —
//     re-summed from catches+stumpings+run-outs. Boundary % Conceded (balls-based)
//     — replaced by Boundary Run %.
const DELETED_FILTER_METRIC_KEYS = new Set([
  "sr_first10", "sr_11_20", "sr_21plus",
  "wickets_per_innings", "not_out_pct", "dismissals_effected", "boundary_pct_conceded",
]);
const isDeletedFilterMetric = (m) => Boolean(m.isPhaseMetric) || DELETED_FILTER_METRIC_KEYS.has(m.key);

/**
 * Mount the condition builder into `advancedHost` (the Advanced Filters section
 * body). Returns `{ onShow, onHide, sync, activeCount, validate }` for main.js.
 */
export function mountFilterDrawer({ advancedHost, keepColumnsCheckbox, noticeEl }, store, { onChange, isKeepColumnsDisabled }) {
  // "Keep Selected Columns" toggle (4d/A5): a plain checkbox in the popup
  // footer (main.js queries it statically from index.html and hands it in
  // here since drawer.js owns the popup's non-Search controls). Reads/writes
  // state.keepColumns directly — display-only, no query builder ever reads
  // it. main.js's reapplyDefaultColumnsIfUnmodified() is the thing this
  // gates (see its own comment for the OFF/ON behaviour).
  //
  // R5-A #10: greyed out when the toggle can't do anything useful — on a blank
  // table (nothing searched yet) or when the pending discipline differs from the
  // last-searched one (the columns it would "keep" belong to the other view).
  // main.js decides that via isKeepColumnsDisabled(); syncKeepColumns() applies
  // it on open + on every store change while the popup is visible.
  const keepColumnsLabelEl = keepColumnsCheckbox ? keepColumnsCheckbox.closest(".fpop-keep-columns") : null;
  function syncKeepColumns() {
    if (!keepColumnsCheckbox) return;
    const s = store.get();
    keepColumnsCheckbox.checked = Boolean(s.keepColumns);
    const disabled = isKeepColumnsDisabled ? Boolean(isKeepColumnsDisabled()) : false;
    keepColumnsCheckbox.disabled = disabled;
    if (keepColumnsLabelEl) {
      keepColumnsLabelEl.classList.toggle("is-disabled", disabled);
      keepColumnsLabelEl.title = disabled
        ? "Available once you've searched — and only while staying on the same discipline"
        : "";
    }
  }
  if (keepColumnsCheckbox) {
    keepColumnsCheckbox.addEventListener("change", () => {
      store.set({ keepColumns: keepColumnsCheckbox.checked });
      onChange();
    });
    syncKeepColumns();
  }

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

  // Wave F1: the five profile pickers are the unified PANEL component now
  // (mountSearchSelect, searchable:false → the P checkbox-panel look for a short
  // fixed vocabulary), not native <select>s. Each still writes the SAME
  // state.profile.* value (string, or null for the "Any …" clear row) and fires
  // onChange, so buildQuery is untouched — only the widget changed.
  const toOptions = (values) => (values || []).map((v) => ({ value: v, label: v }));

  // Role editor: broad role + (conditional) detailed sub-role + (when the broad
  // role is "Bowler") the FINE bowling styles (ROUND 3, task 2). The fine-style
  // picker writes the SAME state.profile.bowlingType as the standalone "Bowling
  // style" condition — they are two editors of one value (see report note on the
  // redundancy). renderProfileEditors keeps both in sync from profile.bowlingType.
  editorHosts.role.innerHTML = `
    <div class="profile-role">
      <div data-role="prof-roleGroup"></div>
      <div data-role="prof-roleSub" hidden></div>
      <div data-role="prof-roleBowling" hidden></div>
    </div>`;
  const roleGroupHost = editorHosts.role.querySelector('[data-role="prof-roleGroup"]');
  const roleSubHost = editorHosts.role.querySelector('[data-role="prof-roleSub"]');
  const roleBowlingHost = editorHosts.role.querySelector('[data-role="prof-roleBowling"]');
  editorHosts.hand.innerHTML = `<div data-role="prof-hand"></div>`;
  const handHost = editorHosts.hand.querySelector('[data-role="prof-hand"]');
  editorHosts.bowling.innerHTML = `<div data-role="prof-bowling"></div>`;
  const bowlingHost = editorHosts.bowling.querySelector('[data-role="prof-bowling"]');

  const roleGroupSel = mountSearchSelect(roleGroupHost, {
    searchable: false,
    portal: true,
    ariaLabel: "Playing role",
    placeholder: "Any role",
    allowEmptyLabel: "Any role",
    onChange: (val) => {
      setProfile({ roleGroup: val || null, roleSub: null });
      renderProfileEditors();
      onChange();
    },
  });
  const roleSubSel = mountSearchSelect(roleSubHost, {
    searchable: false,
    portal: true,
    ariaLabel: "Detailed role",
    placeholder: "Any",
    allowEmptyLabel: "Any",
    onChange: (val) => {
      setProfile({ roleSub: val || null });
      onChange();
    },
  });
  const roleBowlingSel = mountSearchSelect(roleBowlingHost, {
    searchable: false,
    portal: true,
    ariaLabel: "Bowling style",
    placeholder: "Any bowling style",
    allowEmptyLabel: "Any bowling style",
    onChange: (val) => {
      setProfile({ bowlingType: val || null });
      renderProfileEditors();
      onChange();
    },
  });
  const handSel = mountSearchSelect(handHost, {
    searchable: false,
    portal: true,
    ariaLabel: "Batting hand",
    placeholder: "Any",
    allowEmptyLabel: "Any",
    onChange: (val) => {
      setProfile({ battingHand: val || null });
      onChange();
    },
  });
  const bowlingSel = mountSearchSelect(bowlingHost, {
    searchable: false,
    portal: true,
    ariaLabel: "Bowling style",
    placeholder: "Any",
    allowEmptyLabel: "Any",
    onChange: (val) => {
      setProfile({ bowlingType: val || null });
      onChange();
    },
  });

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

  // Push the current option lists + values into the mounted panels (setOptions
  // before setValue so a value always resolves against a fresh list). Same
  // show/hide rules the native <select>s had — the change handlers now live in
  // each panel's onChange above.
  function renderProfileEditors() {
    const p = store.get().profile;
    roleGroupSel.setOptions(toOptions(profileOptions.roleGroups));
    roleGroupSel.setValue(p.roleGroup);
    const subs = p.roleGroup ? profileOptions.subByGroup[p.roleGroup] || [] : [];
    if (subs.length > 0) {
      roleSubSel.setOptions(toOptions(subs));
      roleSubSel.setValue(p.roleSub);
      roleSubHost.hidden = false;
    } else {
      roleSubHost.hidden = true;
    }
    // Fine bowling styles: shown only when the broad role is "Bowler". Hiding it
    // (role changed away from Bowler) never CLEARS bowlingType — the standalone
    // "Bowling style" condition may own that value; the pill keeps it honest.
    if (p.roleGroup === "Bowler" && profileOptions.bowlingTypes.length > 0) {
      roleBowlingSel.setOptions(toOptions(profileOptions.bowlingTypes));
      roleBowlingSel.setValue(p.bowlingType);
      roleBowlingHost.hidden = false;
    } else {
      roleBowlingHost.hidden = true;
    }
    handSel.setOptions(toOptions(profileOptions.battingHands));
    handSel.setValue(p.battingHand);
    bowlingSel.setOptions(toOptions(profileOptions.bowlingTypes));
    bowlingSel.setValue(p.bowlingType);
  }

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

  // ── Editors for R.Pos / striker position / Team / Opposition / Event / Venue ─
  // R5-A #8: R. Pos. (plain modal-position filter, state.regularPositions) and the
  // matchup striker "Batting position" (ball-level batter-faced filter,
  // state.positions) now live in SEPARATE rows/editor hosts. Previously they
  // shared one row and the striker control un-hid whenever a Vs bucket was picked,
  // so choosing Vs=Spin sprouted a second dropdown inside the R. Pos. row. They no
  // longer share a host: R. Pos. mounts in its own `rpos` row (batting contexts),
  // the striker mounts in its own `strikerpos` row (matchup only, never auto-shown).
  // Neither filter's QUERY changed — only where each control lives.
  const regularPositionController = mountRegularPositions(editorHosts.rpos, store, onChange, { embedded: true });
  const matchupPositionController = mountBattingPosition(editorHosts.strikerpos, store, onChange, { embedded: true });
  // The five CASCADING pickers each know which of their picked values the rest of
  // the filters have made impossible, and tell us when their option list reloads
  // (onOptionsLoaded) so the empty-result notice below can be re-derived — a load
  // changes nothing in state, so nothing else would prompt a refresh.
  const onCascadeOptionsLoaded = () => syncEmptyNotice();
  const teamController = mountTeam(editorHosts.team, store, onChange, { onOptionsLoaded: onCascadeOptionsLoaded });
  const oppositionController = mountOpposition(editorHosts.opposition, store, onChange, { embedded: true, onOptionsLoaded: onCascadeOptionsLoaded });
  const eventController = mountEvent(editorHosts.event, store, onChange, { onOptionsLoaded: onCascadeOptionsLoaded });
  const venueController = mountVenue(editorHosts.venue, store, onChange, { onOptionsLoaded: onCascadeOptionsLoaded });
  const fieldingPositionController = mountFieldingPosition(editorHosts.fld_pos, store, onChange, { embedded: true });
  const fieldingKindController = mountFieldingKind(editorHosts.fld_kind, store, onChange, { embedded: true });
  const fieldingPhaseController = mountFieldingPhase(editorHosts.fld_phase, store, onChange, { embedded: true });
  // Match-context editors (Wave 6): each writes only its own state key.
  const resultController = mountResult(editorHosts.mc_result, store, onChange, { embedded: true });
  const tossResultController = mountTossResult(editorHosts.mc_toss_result, store, onChange, { embedded: true });
  const tossDecisionController = mountTossDecision(editorHosts.mc_toss_decision, store, onChange, { embedded: true });
  const inningsOrderController = mountInningsOrder(editorHosts.mc_innings_order, store, onChange, { embedded: true });
  const stageController = mountStage(editorHosts.mc_stage, store, onChange, { embedded: true, onOptionsLoaded: onCascadeOptionsLoaded });
  // Delivery window (Wave 3, decision 67; UI-A REWORK): the four separate window
  // editors, each mounted into its own singleton row and writing its own piece of
  // state.deliveryWindow. Mounted unconditionally (their skeleton rows are built
  // like every singleton), but each only ever becomes VISIBLE / addable while the
  // ball engine is active (+ its format gate) — see isPresent + addSelectOptionsHTML.
  // Flag-OFF they stay hidden, inert rows that never write state.deliveryWindow.
  const winPhaseController = mountWindowPhase(editorHosts.win_phase, store, onChange, { embedded: true });
  const winOversController = mountWindowOvers(editorHosts.win_overs, store, onChange, { embedded: true });
  const winBallsController = mountWindowBalls(editorHosts.win_balls, store, onChange, { embedded: true });
  const winPlayerController = mountWindowPlayer(editorHosts.win_player, store, onChange, { embedded: true });

  // ── "This will come back empty" notice (owner ruling) ──────────────────────
  // Since a dead-end pick is now KEPT and greyed rather than reset, a search can
  // legitimately return no rows. When one filter's ENTIRE selection is currently
  // impossible, that filter ALONE guarantees an empty result — a fact each picker
  // already has from its own option list, so this costs no extra query. Say so
  // plainly, name the control, and leave Search fully enabled: it informs, it
  // never blocks. Only these five report; the fixed-vocabulary pickers (Result,
  // Toss…, Innings order) have no cross-filtered list and can't go dead this way.
  const cascadeControllers = [venueController, eventController, teamController, oppositionController, stageController];
  const noticeMainEl = noticeEl ? noticeEl.querySelector('[data-role="fpop-notice-main"]') : null;
  const noticeHintEl = noticeEl ? noticeEl.querySelector('[data-role="fpop-notice-hint"]') : null;

  /** "Venue selection (Lord's, The Oval)" — the control's name plus what is in it,
   * capped so a long list can't run away. */
  function describeDeadFilter(report) {
    const shown = report.values.slice(0, 3);
    const extra = report.values.length - shown.length;
    const list = shown.join(", ") + (extra > 0 ? `, and ${extra} more` : "");
    return `${report.label} selection (${list})`;
  }

  function syncEmptyNotice() {
    if (!noticeEl || !noticeMainEl || !noticeHintEl) return;
    const reports = [];
    for (const c of cascadeControllers) {
      const r = c.deadReport ? c.deadReport() : null;
      if (r && r.values.length) reports.push(r);
    }
    if (reports.length === 0) {
      noticeEl.hidden = true;
      noticeMainEl.textContent = "";
      noticeHintEl.textContent = "";
      return;
    }
    const parts = reports.map(describeDeadFilter);
    const list =
      parts.length === 1
        ? parts[0]
        : `${parts.slice(0, -1).join("; ")}${parts.length > 2 ? ";" : ""} and ${parts[parts.length - 1]}`;
    const verb = reports.length === 1 ? "has" : "have";
    noticeMainEl.textContent = `No matches: your ${list} ${verb} no games once your other filters are applied.`;
    noticeHintEl.textContent =
      reports.length === 1
        ? "You can still press Search — it will just come back with nothing. To get results, untick the greyed-out value in that list, or loosen your other filters."
        : "You can still press Search — it will just come back with nothing. To get results, untick the greyed-out values in those lists, or loosen your other filters.";
    noticeEl.hidden = false;
  }

  // ── Presence + session-added tracking ──────────────────────────────────────
  // sessionAdded: singleton rows the user added THIS popup session that don't
  // yet carry a value. Reset on every popup open (onShow) so never-filled rows
  // don't linger — presence then re-derives purely from state values.
  const sessionAdded = {};

  function hasValue(key, s) {
    switch (key) {
      // Delivery window (Wave 3, decision 67; UI-A REWORK): each of the four window
      // filters is present when ITS OWN piece of state.deliveryWindow is set. Gated
      // on the ball engine too — flag-OFF deliveryWindow is always null, so this is
      // belt-and-suspenders against the rows ever surfacing there. (Phase/Ball-range
      // additionally hide outside a single T20/50-over bucket — see isPresent.)
      case "win_phase": return ballEngineEnabled() && Boolean(s.deliveryWindow && Array.isArray(s.deliveryWindow.phase) && s.deliveryWindow.phase.length > 0);
      case "win_overs": return ballEngineEnabled() && Boolean(s.deliveryWindow && s.deliveryWindow.overs);
      case "win_balls": return ballEngineEnabled() && Boolean(s.deliveryWindow && s.deliveryWindow.balls);
      case "win_player": return ballEngineEnabled() && Boolean(s.deliveryWindow && s.deliveryWindow.player);
      case "role": return Boolean(s.profile.roleGroup);
      // Batting hand is a batting-only concept (decision 54): a player's
      // batting hand isn't their bowling arm, so the row (and the value) never
      // shows while the bowling discipline is active. Mirrors rpos's own
      // discipline gate just below. The store already clears profile.battingHand
      // on every discipline change (state.js swapAdvancedForDiscipline), so this
      // is belt-and-suspenders against a stale value ever resurfacing here.
      case "hand": return s.discipline === "batting" && Boolean(s.profile.battingHand);
      case "bowling": return Boolean(s.profile.bowlingType);
      case "vs": return matchupVsActive(s); // present iff a Vs bucket applies to the current discipline
      // R5-A #8: R. Pos. (regularPositions) and the striker position (positions)
      // are now separate rows. R. Pos. is a batting concept — present in batting
      // contexts when it has a value; the striker is matchup-only — present when
      // it has a value (isPresent additionally gates strikerpos on matchupVsActive
      // so it never shows outside matchup, and never merely because a Vs bucket
      // was picked with no position chosen).
      case "rpos":
        return s.discipline === "batting" && (s.regularPositions || []).length > 0;
      case "strikerpos":
        return (s.positions || []).length > 0;
      case "team": return (s.teams || []).length > 0;
      case "opposition": return (s.opposition || []).length > 0;
      case "event": return (s.event || []).length > 0;
      case "venue": return (s.venue || []).length > 0;
      // Fielding SLICE conditions: present when their list has a value.
      case "fld_pos": return Boolean(s.fielding && (s.fielding.positions || []).length > 0);
      case "fld_kind": return Boolean(s.fielding && (s.fielding.kinds || []).length > 0);
      case "fld_phase": return Boolean(s.fielding && (s.fielding.phases || []).length > 0);
      // Match-context singletons (Wave 6): present when their value is set. Result
      // (FIX A) and Stage (polish item 3) are present once their condition is added
      // — each seeded to ["all"] (the "All" default) — so length > 0 covers both All
      // and specific picks; Result Condition (state.resultCondition) has no separate
      // row (it nests inside Result).
      case "mc_result": return (s.result || []).length > 0;
      case "mc_toss_result": return (s.tossResult || []).length > 0;
      case "mc_toss_decision": return (s.tossDecision || []).length > 0;
      case "mc_innings_order": return (s.inningsOrder || []).length > 0;
      case "mc_stage": return (s.stage || []).length > 0;
      default: return false;
    }
  }

  const FIELDING_SLICE_KEYS = new Set(["fld_pos", "fld_kind", "fld_phase"]);

  function isPresent(t, s) {
    if (t.menOnly && s.gender === "female") return false;
    // Delivery window (Wave 3): ball-engine-only — never shows, nor auto-appears,
    // while the flag is OFF (a window can't apply to the pre-summed parquet path).
    if (t.ballOnly && !ballEngineEnabled()) return false;
    // Phase / Ball range are gated to a single T20 / 50-over bucket (decision 67):
    // never show, nor auto-appear, in red-ball or mixed formats, even if a stale
    // piece or a session-add lingers (pruneDeliveryWindowForFormats already drops a
    // now-illegal piece from the store; this keeps the ROW honest to match).
    if ((t.key === "win_phase" || t.key === "win_balls") && !windowPhaseBallsAllowed(s)) return false;
    // R5-A #8: the striker "Batting position" is matchup-only — it never shows
    // (nor auto-appears) outside matchup mode, even if a stale position value or a
    // session-add lingers. Inside matchup it follows the normal presence rule.
    if (t.key === "strikerpos" && !matchupVsActive(s)) return false;
    // Fielding SLICE conditions are PLAIN-mode only (fielding has no matchup
    // grain) — never show, nor auto-appear, while a Vs bucket is active.
    if (FIELDING_SLICE_KEYS.has(t.key) && matchupVsActive(s)) return false;
    return hasValue(t.key, s) || Boolean(sessionAdded[t.key]);
  }

  function clearSingleton(key) {
    switch (key) {
      case "win_phase": store.set({ deliveryWindow: withDeliveryWindowPiece(store.get().deliveryWindow, "phase", null) }); break;
      case "win_overs": store.set({ deliveryWindow: withDeliveryWindowPiece(store.get().deliveryWindow, "overs", null) }); break;
      case "win_balls": store.set({ deliveryWindow: withDeliveryWindowPiece(store.get().deliveryWindow, "balls", null) }); break;
      case "win_player": store.set({ deliveryWindow: withDeliveryWindowPiece(store.get().deliveryWindow, "player", null) }); break;
      case "role": setProfile({ roleGroup: null, roleSub: null }); break;
      case "hand": setProfile({ battingHand: null }); break;
      case "bowling": setProfile({ bowlingType: null }); break;
      case "vs": store.set({ matchupVs: null }); break;
      case "rpos": store.set({ regularPositions: [] }); break;
      case "strikerpos": store.set({ positions: [] }); break;
      case "team": store.set({ teams: [] }); break;
      case "opposition": store.set({ opposition: [] }); break;
      case "event": store.set({ event: [], eventSeasons: {} }); break; // Wave 6 pt2: drop season narrowing too
      case "venue": store.set({ venue: [] }); break;
      case "fld_pos": store.set({ fielding: { ...(store.get().fielding || {}), positions: [] } }); break;
      case "fld_kind": store.set({ fielding: { ...(store.get().fielding || {}), kinds: [] } }); break;
      case "fld_phase": store.set({ fielding: { ...(store.get().fielding || {}), phases: [] } }); break;
      // Removing Result also removes its nested Result Condition (FIX B).
      case "mc_result": store.set({ result: [], resultCondition: [] }); break;
      case "mc_toss_result": store.set({ tossResult: [] }); break;
      case "mc_toss_decision": store.set({ tossDecision: [] }); break;
      case "mc_innings_order": store.set({ inningsOrder: [] }); break;
      case "mc_stage": store.set({ stage: [] }); break;
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
  function metricLabel(metricKey, ns, formats) {
    const m = getMetric(metricKey, ns) || getMetric(metricKey);
    return m ? metricDisplayLabel(m, formats) : metricKey;
  }

  // Dismissal-type labels drop the leading "Out " (R5 Wave 1a, item 7: "Caught"
  // not "Out Caught"). Display-only — the metric KEYS/labels in metrics.js are
  // untouched; this strips the prefix at render time only. The bowling wkt_*
  // labels have no "Out " prefix, so this is a no-op for them.
  const stripOutPrefix = (label) => label.replace(/^Out\s+/, "");

  // ── "+ Add condition" search palette (filter-rejig Wave R2, decision 68) ──────
  // The native <select> is replaced by the owner-chosen Option-C "search-first
  // palette": a trigger opens a portaled popover with a pinned search box + the 7
  // filter groups as headers; typing filters leaf labels AND ▸ variant names; ▸
  // families expand inline; a "No matching filter" empty state. buildPaletteGroups
  // returns the taxonomy; each leaf's run() fires the SAME store mutation the old
  // <select> did (pickSingleton = the c: path, pickMetric = the m: path), so the
  // query builders are untouched (numbers sacred). Renames/regroup/deletes/fold
  // are all DISPLAY-ONLY, expressed in the taxonomy below.
  //
  // The ▸ sub-filter mechanic: an entry expands to variants; a variant either adds
  // a distinct metric (Dismissal Type / Wicket Types / % Runs in… / Balls per… /
  // Extras) OR reveals a categorical singleton row with that value pre-selected
  // (Match/Toss Result → distinct singletons; Phase / Fielding Wicket Type /
  // Wickets by Batting Position / vs bowling style / vs batting hand → one singleton
  // pre-filled; Batter/Bowler Ball Range → win_player edge pre-set). Pre-selecting a
  // categorical value is equivalent to the user ticking it in the row (the row
  // editors derive display from state), so it moves numbers only because the user
  // chose a filter — not a query-builder change.

  /** The c: path: reveal a singleton row (optionally pre-selecting a categorical
   * value via `preselect`), seeding Result/Stage defaults exactly as before. */
  function pickSingleton(key, preselect) {
    sessionAdded[key] = true;
    // Result (FIX A/B): adding auto-checks "All" for BOTH the Result outcome
    // picker and its nested Result Condition — no narrowing until a specific is
    // picked, so the query stays byte-identical. Stage gets the same "All" default.
    if (key === "mc_result") {
      const st = store.get();
      const patch = {};
      if ((st.result || []).length === 0) patch.result = ["all"];
      if ((st.resultCondition || []).length === 0) patch.resultCondition = ["all"];
      if (Object.keys(patch).length) store.set(patch);
    } else if (key === "mc_stage") {
      if ((store.get().stage || []).length === 0) store.set({ stage: ["all"] });
    }
    if (preselect) preselect();
    syncSingletonRows();
    renderNumeric(store.get(), true); // refresh presence-driven palette disabled states
    onChange();
  }

  /** The m: path: append a numeric condition on `metricKey` to group `gi` and
   * focus the freshly-added row's value input (identical to the old <select>). */
  function pickMetric(gi, metricKey) {
    addConditionToGroup(store, gi, metricKey);
    renderNumeric(store.get(), true);
    const groupEl = numericEl.querySelector(`.cond-group[data-gi="${gi}"]`);
    const inputs = (groupEl || numericEl).querySelectorAll('.cond-row--metric [data-role="v1"]');
    if (inputs.length) inputs[inputs.length - 1].focus();
    onChange();
  }

  // Pre-select closures for the categorical singleton ▸ families (each equivalent
  // to the user ticking that value in the revealed row).
  const preselectPhase = (v) => () =>
    store.set({ deliveryWindow: withDeliveryWindowPiece(store.get().deliveryWindow, "phase", [v]) });
  const preselectFielding = (field, value) => () =>
    store.set({ fielding: { ...(store.get().fielding || {}), [field]: [value] } });
  const preselectMatchupVs = (dim, value) => () => store.set({ matchupVs: { dim, value } });
  const preselectEdge = (edge) => () => winPlayerController.presetEdge(edge);

  /**
   * Build the 7-group palette taxonomy for the current state, with each metric
   * condition targeting group `gi`. Returns [{ name, note?, items }]; an item is
   * { kind:'leaf', label, disabled?, run } or { kind:'family', label, disabled?,
   * variants:[leaf…] }. Discipline-aware, gender/format/matchup gated exactly as
   * the old dropdown was. Metric leaves are drawn from the SAME source the old
   * dropdown used — partitionFilterMetrics(eligibleMetrics(ns)) minus the deletes —
   * so no eligible metric is ever lost: anything not placed by the explicit spec
   * structure is appended to the discipline's Detailed group (catch-all), which
   * also covers the matchup namespaces' own metric sets.
   */
  function buildPaletteGroups(s, gi) {
    const ns = effectiveNamespace(s);
    const women = s.gender === "female";
    const disc = s.discipline;
    const matchup = matchupVsActive(s);
    const ballOn = ballEngineEnabled();
    const winPB = windowPhaseBallsAllowed(s);

    // R. Pos. (kind:"position") is a mode value, never a numeric condition; drop
    // it and the deleted keys before partitioning (same source as the old picker).
    const numericMetrics = eligibleMetrics(ns, s.formats)
      .filter((m) => m.kind !== "position" && !isDeletedFilterMetric(m));
    const parts = partitionFilterMetrics(numericMetrics);
    const eligibleByKey = new Map(numericMetrics.map((m) => [m.key, m]));
    const placed = new Set(); // metric keys already placed by the explicit structure

    const presentSingles = new Set(SINGLETON_TYPES.filter((t) => isPresent(t, s)).map((t) => t.key));
    const singlePresent = (key) => presentSingles.has(key);

    // ── item builders ──────────────────────────────────────────────────────────
    const leafMetric = (key, label) => {
      const m = eligibleByKey.get(key);
      if (!m) return null; // not eligible in this namespace/format — skip gracefully
      placed.add(key);
      return { kind: "leaf", label: label ?? metricDisplayLabel(m, s.formats), run: () => pickMetric(gi, key) };
    };
    const leafSingle = (key, label, preselect = null) => ({
      kind: "leaf", label, disabled: singlePresent(key), run: () => pickSingleton(key, preselect),
    });
    const metricFamily = (label, variantDefs) => {
      const variants = variantDefs.map(([key, vlabel]) => leafMetric(key, vlabel)).filter(Boolean);
      return variants.length ? { kind: "family", label, variants } : null;
    };
    // A categorical ▸ family bound to ONE singleton: variants pre-select a value;
    // the family + variants disable once that singleton row is present.
    const singleFamily = (label, key, variantDefs) => {
      const present = singlePresent(key);
      const variants = variantDefs.map(([vlabel, preselect]) => ({
        kind: "leaf", label: vlabel, disabled: present, run: () => pickSingleton(key, preselect),
      }));
      return { kind: "family", label, disabled: present, variants };
    };
    const pushGroup = (name, items, note) => {
      const kept = items.filter(Boolean);
      if (kept.length) groups.push({ name, note, items: kept });
    };

    const groups = [];

    // 1 ── Player Profile ────────────────────────────────────────────────────────
    pushGroup("Player Profile", [
      !women ? leafSingle("role", "Playing role") : null,
      !women && disc === "batting" ? leafSingle("hand", "Batting hand") : null,
      !women ? leafSingle("bowling", "Bowling style") : null,
      disc === "batting" ? leafSingle("rpos", "Regular batting position") : null,
      leafSingle("team", "Team"),
    ]);

    // 2 ── Match Details ─────────────────────────────────────────────────────────
    const matchResultFamily = {
      kind: "family", label: "Match/Toss Result",
      variants: [
        { kind: "leaf", label: "Match Result", disabled: singlePresent("mc_result"), run: () => pickSingleton("mc_result") },
        { kind: "leaf", label: "Toss Result", disabled: singlePresent("mc_toss_result"), run: () => pickSingleton("mc_toss_result") },
        { kind: "leaf", label: "Toss Decision", disabled: singlePresent("mc_toss_decision"), run: () => pickSingleton("mc_toss_decision") },
      ],
    };
    pushGroup("Match Details", [
      leafSingle("opposition", "Opposition"),
      leafSingle("event", "Event"),
      leafSingle("venue", "Venue"),
      leafSingle("mc_stage", "Stage"),
      // "Innings order" (batted / bowled first) kept as-is; the spec's replacement
      // Innings Number filter needs a query-builder wave (see waveR2 progress note).
      leafSingle("mc_innings_order", "Innings order"),
      matchResultFamily,
    ]);

    // 3/4 ── Batting / Bowling metric groups (discipline-specific) ────────────────
    const dismissalVariant = (m) => [m.key, stripOutPrefix(metricDisplayLabel(m, s.formats))];
    if (disc === "batting") {
      pushGroup("Batting · Basic Stats", [
        leafMetric("matches", "Matches"),
        leafMetric("innings", "Innings"),
        leafMetric("runs", "Runs"),
        leafMetric("balls_faced", "Balls Faced"),
        leafMetric("fours", "4s"),
        leafMetric("sixes", "6s"),
        metricFamily("Dismissal Type", parts.dismissal.map(dismissalVariant)),
        leafMetric("ducks", "Ducks"),
        leafMetric("not_outs", "Not Outs"),
        leafMetric("high_score", "High Score"),
        leafMetric("fifties", "50s"),
        leafMetric("hundreds", "100s"),
        leafMetric("innings_score_ge", "Innings Score ≥ N"),
      ]);
      pushGroup("Batting · Detailed Stats", [
        leafMetric("average", "Batting Average"),
        leafMetric("strike_rate", "Batting Strike Rate"),
        leafMetric("balls_per_dismissal", "Balls per Dismissal"),
        leafMetric("boundary_pct", "Boundary Ball %"),
        leafMetric("boundary_runs_pct", "Boundary Run %"),
        leafMetric("dot_pct", "Dot %"),
        leafMetric("running_sr", "NBSR"),
        leafMetric("balls_faced_share", "Percentage of Balls Faced"),
        metricFamily("Balls per…", [["balls_per_boundary", "Boundary"], ["balls_per_four", "4"], ["balls_per_six", "6"]]),
        metricFamily("% Runs in…", [
          ["runs_1s_pct", "1s"], ["runs_2s_pct", "2s"], ["runs_3s_pct", "3s"],
          ["runs_4s_boundary_pct", "4s-boundary"], ["runs_4s_run_pct", "4s-run"],
          ["runs_5s_pct", "5s"], ["runs_6s_boundary_pct", "6s-boundary"], ["runs_6s_run_pct", "6s-run"],
        ]),
        ...leftoverLeaves(parts, placed, gi, eligibleByKey, s),
      ]);
    } else {
      pushGroup("Bowling · Basic Stats", [
        leafMetric("matches", "Matches"),
        leafMetric("innings", "Innings"),
        leafMetric("overs", "Overs"),
        leafMetric("balls", "Balls"),
        leafMetric("maidens", "Maidens"),
        leafMetric("runs_conceded", "Runs Conceded"),
        leafMetric("wickets", "Wickets"),
        metricFamily("Wicket Types", parts.dismissal.map((m) => [m.key, metricDisplayLabel(m, s.formats)])),
        leafMetric("best", "Best Bowling"),
        leafMetric("four_wicket_hauls", "4-WI"),
        leafMetric("five_wicket_hauls", "5-WI"),
        leafMetric("wicket_hauls_ge", "Wicket Hauls ≥ N"),
      ]);
      pushGroup("Bowling · Detailed Stats", [
        leafMetric("average", "Bowling Average"),
        leafMetric("economy", "Economy"),
        leafMetric("strike_rate", "Bowling Strike Rate"),
        metricFamily("Extras", [["extras_wides", "Wides"], ["extras_noballs", "No-balls"]]),
        leafMetric("dot_pct", "Dot %"),
        leafMetric("boundary_runs_pct", "Boundary Run %"),
        ...leftoverLeaves(parts, placed, gi, eligibleByKey, s),
      ]);
    }

    // 5 ── Ball Ranges (ball-engine only; folds the four delivery-window entries) ─
    if (ballOn) {
      pushGroup("Ball Ranges", [
        winPB ? singleFamily("Phase", "win_phase", [
          ["Powerplay", preselectPhase("pp")], ["Middle", preselectPhase("mid")], ["Death", preselectPhase("death")],
        ]) : null,
        leafSingle("win_overs", "Over Range"),
        winPB ? leafSingle("win_balls", "Team Ball Range") : null,
        {
          kind: "family", label: "Batter/Bowler Ball Range", disabled: singlePresent("win_player"),
          variants: [
            { kind: "leaf", label: "First N", disabled: singlePresent("win_player"), run: () => pickSingleton("win_player", preselectEdge("first")) },
            { kind: "leaf", label: "Last N", disabled: singlePresent("win_player"), run: () => pickSingleton("win_player", preselectEdge("last")) },
          ],
        },
      ]);
    }

    // 6 ── Matchup (Vs) — men only (needs a profile) ──────────────────────────────
    if (!women) {
      const vsItems = [];
      if (disc === "batting") {
        const vsTypes = vsBowlingTypes || [];
        vsItems.push(singleFamily("vs bowling style", "vs", [
          ["Pace", preselectMatchupVs("group", "Pace")],
          ["Spin", preselectMatchupVs("group", "Spin")],
          ...vsTypes.map((t) => [matchupBucketLabel(t), preselectMatchupVs("type", t)]),
        ]));
        // Fine bowling styles load lazily (matchup_batting distinct-values); once
        // they arrive, rebuild so they appear as variants (renderNumeric closes any
        // open palette first). One-shot: the next build has vsBowlingTypes set, so
        // this branch won't re-fire.
        if (!vsBowlingTypes) loadVsBowlingTypes().then((types) => { if (types && types.length) renderNumeric(store.get(), true); });
      } else {
        vsItems.push(singleFamily("vs batting hand", "vs", [
          ["Right-hand bat", preselectMatchupVs("hand", "Right-hand bat")],
          ["Left-hand bat", preselectMatchupVs("hand", "Left-hand bat")],
        ]));
      }
      if (matchup) vsItems.push(leafSingle("strikerpos", "Batting position"));
      pushGroup("Matchup (Vs)", vsItems, "men only");
    }

    // 7 ── Fielding Stats (plain mode only — no matchup grain) ─────────────────────
    if (!matchup) {
      pushGroup("Fielding Stats", [
        singleFamily("Fielding Wicket Type", "fld_kind", FIELDING_KIND_OPTIONS.map((o) => [o.label, preselectFielding("kinds", o.value)])),
        singleFamily("Wickets by Batting Position", "fld_pos", FIELDING_POSITIONS.map((n) => [`Position ${n}`, preselectFielding("positions", n)])),
        ...parts.fielding.map((m) => leafMetric(m.key, metricDisplayLabel(m, s.formats))),
        ...parts.impact.map((m) => leafMetric(m.key, metricDisplayLabel(m, s.formats))),
      ]);
    }

    return groups;
  }

  /** Any eligible metric NOT placed by the explicit spec structure (basic ∪
   * advanced partitions) — appended to the discipline's Detailed group so nothing
   * is ever lost, and the matchup namespaces' own metric sets still surface. */
  function leftoverLeaves(parts, placed, gi, eligibleByKey, s) {
    return [...parts.basic, ...parts.advanced]
      .filter((m) => !placed.has(m.key))
      .map((m) => {
        placed.add(m.key);
        return { kind: "leaf", label: metricDisplayLabel(m, s.formats), run: () => pickMetric(gi, m.key) };
      });
  }

  // ── Palette component (portal + search + ▸ drill-down) ───────────────────────
  // Only one palette is open at a time; renderNumeric closes it before any rebuild
  // (a portaled-open panel would orphan on <body>). currentPaletteClose tracks it.
  let currentPaletteClose = null;

  /** Leak-free portal for the palette panel: doc listeners are added on open and
   * REMOVED on close, so re-creating the palette on every numeric rebuild never
   * leaks (unlike wirePortalDropdown, whose doc listeners are permanent — fine for
   * its once-mounted callers, wrong here). Positioning mirrors wirePortalDropdown. */
  function portalPanel(toggleEl, panelEl, { onOpen } = {}) {
    const home = { parent: panelEl.parentNode, next: panelEl.nextSibling };
    let opened = false;
    function position() {
      const r = toggleEl.getBoundingClientRect();
      const margin = 8;
      panelEl.style.position = "fixed";
      panelEl.style.zIndex = "1000"; // above the .filters-popup panel (z-index:100)
      panelEl.style.minWidth = `${Math.round(r.width)}px`;
      panelEl.style.top = `${Math.round(r.bottom + 6)}px`;
      const width = panelEl.offsetWidth || Math.round(r.width);
      let left = Math.min(r.left, window.innerWidth - width - margin);
      left = Math.max(margin, left);
      panelEl.style.left = `${Math.round(left)}px`;
      panelEl.style.right = "auto";
      const maxH = Math.max(160, Math.round(window.innerHeight - (r.bottom + 6) - margin));
      panelEl.style.maxHeight = `${maxH}px`;
      panelEl.style.overflowY = "auto";
    }
    const onScroll = () => { if (opened) position(); };
    const onResize = () => { if (opened) position(); };
    const onDocClick = (e) => {
      if (!opened) return;
      if (panelEl.contains(e.target) || toggleEl === e.target || toggleEl.contains(e.target)) return;
      close();
    };
    const onKeydown = (e) => {
      if (e.key === "Escape" && opened) { close(); e.stopPropagation(); }
    };
    function open() {
      if (opened || toggleEl.disabled) return;
      if (currentPaletteClose && currentPaletteClose !== close) currentPaletteClose();
      opened = true;
      panelEl.hidden = false;
      document.body.appendChild(panelEl);
      position();
      toggleEl.setAttribute("aria-expanded", "true");
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", onResize);
      document.addEventListener("click", onDocClick, true);
      document.addEventListener("keydown", onKeydown, true);
      currentPaletteClose = close;
      if (onOpen) onOpen();
    }
    function close() {
      if (!opened) return;
      opened = false;
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("click", onDocClick, true);
      document.removeEventListener("keydown", onKeydown, true);
      panelEl.hidden = true;
      for (const p of ["position", "zIndex", "minWidth", "top", "left", "right", "maxHeight", "overflowY"]) panelEl.style[p] = "";
      if (home.next && home.next.parentNode === home.parent) home.parent.insertBefore(panelEl, home.next);
      else home.parent.appendChild(panelEl);
      toggleEl.setAttribute("aria-expanded", "false");
      if (currentPaletteClose === close) currentPaletteClose = null;
    }
    toggleEl.addEventListener("click", () => { if (opened) close(); else open(); });
    return { open, close };
  }

  /** Build + wire ONE add-condition palette (one per numeric group card). */
  function mountAddPalette(addctlEl) {
    const gi = Number(addctlEl.dataset.gi);
    const toggleEl = addctlEl.querySelector('[data-role="palette-toggle"]');
    const panelEl = addctlEl.querySelector('[data-role="palette-panel"]');
    const searchEl = addctlEl.querySelector('[data-role="palette-search"]');
    const listEl = addctlEl.querySelector('[data-role="palette-list"]');
    const emptyEl = addctlEl.querySelector('[data-role="palette-empty"]');

    const portal = portalPanel(toggleEl, panelEl, {
      onOpen: () => { searchEl.value = ""; resetFilter(); searchEl.focus(); },
    });
    const doPick = (run) => { portal.close(); run(); };

    // ── list DOM ────────────────────────────────────────────────────────────────
    const labelHTML = (label) =>
      `<span class="palette__row-label" data-text="${escAttr(label)}">${escHtml(label)}</span>`;
    for (const g of buildPaletteGroups(store.get(), gi)) {
      const groupEl = document.createElement("div");
      groupEl.className = "palette__group";
      const header = document.createElement("div");
      header.className = "palette__group-header";
      header.innerHTML = `${escHtml(g.name)}${g.note ? `<span class="palette__group-note"> (${escHtml(g.note)})</span>` : ""}`;
      groupEl.appendChild(header);

      for (const item of g.items) {
        if (item.kind === "family") {
          const row = document.createElement("button");
          row.type = "button";
          row.className = `palette__row palette__row--family${item.disabled ? " is-disabled" : ""}`;
          row.dataset.label = item.label.toLowerCase();
          row.setAttribute("aria-expanded", "false");
          row.innerHTML = `${labelHTML(item.label)}<span class="palette__chevron" aria-hidden="true">›</span>`;
          groupEl.appendChild(row);
          const wrap = document.createElement("div");
          wrap.className = "palette__variants";
          wrap.hidden = true;
          for (const v of item.variants) {
            const vRow = document.createElement("button");
            vRow.type = "button";
            vRow.className = `palette__variant-row${v.disabled ? " is-disabled" : ""}`;
            vRow.dataset.label = v.label.toLowerCase();
            vRow.innerHTML = labelHTML(v.label);
            if (!v.disabled) vRow.addEventListener("click", (e) => { e.stopPropagation(); doPick(v.run); });
            wrap.appendChild(vRow);
          }
          groupEl.appendChild(wrap);
          if (!item.disabled) {
            row.addEventListener("click", () => {
              const willOpen = wrap.hidden;
              wrap.hidden = !willOpen;
              row.classList.toggle("is-open", willOpen);
              row.setAttribute("aria-expanded", String(willOpen));
            });
          }
        } else {
          const row = document.createElement("button");
          row.type = "button";
          row.className = `palette__row${item.disabled ? " is-disabled" : ""}`;
          row.dataset.label = item.label.toLowerCase();
          row.innerHTML = labelHTML(item.label);
          if (!item.disabled) row.addEventListener("click", () => doPick(item.run));
          groupEl.appendChild(row);
        }
      }
      listEl.appendChild(groupEl);
    }

    // ── search / highlight ────────────────────────────────────────────────────
    const labelSpan = (rowEl) => rowEl.querySelector(".palette__row-label");
    const clearHi = (rowEl) => { const sp = labelSpan(rowEl); if (sp) sp.textContent = sp.dataset.text; };
    const highlight = (rowEl, q) => {
      const sp = labelSpan(rowEl); if (!sp) return;
      const text = sp.dataset.text;
      const i = text.toLowerCase().indexOf(q);
      if (i < 0) { sp.textContent = text; return; }
      sp.innerHTML = `${escHtml(text.slice(0, i))}<mark>${escHtml(text.slice(i, i + q.length))}</mark>${escHtml(text.slice(i + q.length))}`;
    };
    function resetFilter() {
      listEl.querySelectorAll(".palette__row, .palette__variant-row").forEach((r) => { r.style.display = ""; clearHi(r); });
      listEl.querySelectorAll(".palette__variants").forEach((v) => { v.hidden = true; });
      listEl.querySelectorAll(".palette__row--family").forEach((r) => { r.classList.remove("is-open"); r.setAttribute("aria-expanded", "false"); });
      listEl.querySelectorAll(".palette__group").forEach((g) => { g.style.display = ""; });
      emptyEl.hidden = true;
      listEl.style.display = "";
    }
    function filterList(query) {
      const q = query.trim().toLowerCase();
      if (!q) { resetFilter(); return; }
      let any = false;
      listEl.querySelectorAll(".palette__group").forEach((groupEl) => {
        let groupHas = false;
        groupEl.querySelectorAll(":scope > .palette__row").forEach((row) => {
          const isFamily = row.classList.contains("palette__row--family");
          const wrap = isFamily ? row.nextElementSibling : null;
          const selfMatch = row.dataset.label.includes(q);
          let variantMatch = false;
          if (wrap && wrap.classList.contains("palette__variants")) {
            wrap.querySelectorAll(".palette__variant-row").forEach((vRow) => {
              const show = selfMatch || vRow.dataset.label.includes(q);
              vRow.style.display = show ? "" : "none";
              if (vRow.dataset.label.includes(q)) { variantMatch = true; highlight(vRow, q); } else clearHi(vRow);
            });
            const open = selfMatch || variantMatch;
            wrap.hidden = !open;
            row.classList.toggle("is-open", open);
            row.setAttribute("aria-expanded", String(open));
          }
          const show = selfMatch || variantMatch;
          row.style.display = show ? "" : "none";
          if (selfMatch) highlight(row, q); else clearHi(row);
          if (show) groupHas = true;
        });
        groupEl.style.display = groupHas ? "" : "none";
        if (groupHas) any = true;
      });
      emptyEl.hidden = any;
      listEl.style.display = any ? "" : "none";
    }
    function pickFirstVisible() {
      for (const r of listEl.querySelectorAll(".palette__row, .palette__variant-row")) {
        if (r.style.display === "none" || r.classList.contains("is-disabled") || r.classList.contains("palette__row--family")) continue;
        r.click();
        return;
      }
    }
    searchEl.addEventListener("input", () => filterList(searchEl.value));
    searchEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); pickFirstVisible(); }
      else if (e.key === "Escape") { e.stopPropagation(); portal.close(); toggleEl.focus(); }
    });
  }

  // ── Singleton rows: show/hide + editor sync ─────────────────────────────────
  function syncSingletonRows() {
    const s = store.get();
    for (const t of SINGLETON_TYPES) {
      rowEls[t.key].hidden = !isPresent(t, s);
    }
    // R5-A #8: R. Pos. and the striker "Batting position" are separate rows now,
    // each with its own static type label ("R. Pos." / "Batting position" from
    // SINGLETON_TYPES) — no dynamic relabel or shared-row caption needed. R. Pos.
    // is present only in batting contexts; the striker only in matchup.

    renderVsEditor();
    regularPositionController.sync();
    matchupPositionController.sync();
    teamController.sync();
    oppositionController.sync();
    eventController.sync();
    venueController.sync();
    fieldingPositionController.sync();
    fieldingKindController.sync();
    fieldingPhaseController.sync();
    resultController.sync();
    tossResultController.sync();
    tossDecisionController.sync();
    inningsOrderController.sync();
    stageController.sync();
    winPhaseController.sync();
    winOversController.sync();
    winBallsController.sync();
    winPlayerController.sync();
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

  function conditionRowHTML(cond, gi, ci, ns, formats) {
    const hasError = showErrors && conditionHasError(cond);
    // Best Bowling (Wave A2 item 2): a COMPOUND "≥ [W] wickets for ≤ [R] runs"
    // condition — two labelled boxes (W→v1, R→v2) with NO operator select (the
    // comparison is implicit: at least W wickets conceding at most R runs in a
    // single innings). Every other metric keeps the operator + value layout.
    const isFigures = isBowlingFiguresCondition(cond);
    let valueFields;
    if (isFigures) {
      valueFields = `<span class="cond-row__and">≥</span>
           <input type="number" min="0" step="1" class="input cond-row__value-input" data-role="v1" value="${escAttr(cond.v1)}" placeholder="W" aria-label="wickets" />
           <span class="cond-row__and">wickets for ≤</span>
           <input type="number" min="0" step="1" class="input cond-row__value-input" data-role="v2" value="${escAttr(cond.v2)}" placeholder="R" aria-label="runs" />
           <span class="cond-row__and">runs</span>`;
    } else if (cond.operator === "between") {
      valueFields = `<input type="number" class="input cond-row__value-input" data-role="v1" value="${escAttr(cond.v1)}" placeholder="min" />
           <span class="cond-row__and">and</span>
           <input type="number" class="input cond-row__value-input" data-role="v2" value="${escAttr(cond.v2)}" placeholder="max" />`;
    } else {
      valueFields = `<input type="number" class="input cond-row__value-input" data-role="v1" value="${escAttr(cond.v1)}" placeholder="value" />`;
    }
    const operatorSelect = isFigures
      ? ""
      : `<select class="select" data-role="operator">
              ${OPERATORS.map((o) => `<option value="${o.key}" ${cond.operator === o.key ? "selected" : ""}>${o.label}</option>`).join("")}
            </select>`;
    return `
      <div class="cond-row cond-row--metric ${hasError ? "cond-row--error" : ""}" data-gi="${gi}" data-ci="${ci}">
        <div class="cond-row__line">
          <div class="cond-row__main">
            <span class="cond-row__type">${escHtml(metricLabel(cond.metricKey, ns, formats))}</span>
            ${operatorSelect}
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
    const rows = g.conds.map((c, ci) => conditionRowHTML(c, gi, ci, ns, s.formats)).join("");
    return `
      <div class="cond-group${multi ? " is-multi" : ""}" data-gi="${gi}">
        ${head}
        <div class="cond-group__rows">${rows}</div>
        <div class="cond-group__add">
          <div class="addctl" data-role="add-palette" data-gi="${gi}">
            <button type="button" class="select cond-builder__add-toggle" data-role="palette-toggle" aria-haspopup="dialog" aria-expanded="false" aria-label="Add a filter condition">
              <span class="cond-builder__add-plus" aria-hidden="true">+</span>
              <span class="cond-builder__add-text">Add condition</span>
              <span class="cond-builder__add-caret" aria-hidden="true"></span>
            </button>
            <div class="palette" data-role="palette-panel" hidden>
              <input type="text" class="input palette__search" data-role="palette-search" placeholder="Search filters&hellip;" autocomplete="off" aria-label="Search filters" />
              <div class="palette__list" data-role="palette-list"></div>
              <div class="palette__empty" data-role="palette-empty" hidden>No matching filter.</div>
            </div>
          </div>
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
    // Close any open palette before wiping the cards: a portaled-open panel would
    // otherwise be orphaned on <body> when its host addctl is replaced.
    if (currentPaletteClose) currentPaletteClose();
    numericEl.innerHTML = cards + addGroupBtn;
    wireNumeric();
  }

  function wireNumeric() {
    const groups = realGroups(store.get());

    // Per-group "+ Add condition" search palettes (one per group card, by data-gi).
    // Each builds its taxonomy from the live state and fires pickSingleton / pickMetric.
    numericEl.querySelectorAll('[data-role="add-palette"]').forEach((el) => mountAddPalette(el));

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

      // Best Bowling (bowlingFigures) rows suppress the operator select, so it
      // may be absent — bind only when present.
      const opSel = rowEl.querySelector('[data-role="operator"]');
      if (opSel) {
        opSel.addEventListener("change", () => {
          const wasBetween = cond.operator === "between";
          cond.operator = opSel.value;
          store.set({ advanced: { ...store.get().advanced } });
          if (wasBetween !== (cond.operator === "between")) renderNumeric(store.get(), true);
          onChange();
        });
      }

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
    syncKeepColumns();
    syncEmptyNotice();
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
    // Delivery window (Wave 3, decision 67; UI-A REWORK): one per ACTIVE window
    // piece (Phase / Over range / Ball range / Player balls), matching the four
    // separate pills (flag-OFF deliveryWindow is always null → zero pieces here).
    n += deliveryWindowTokens(s.deliveryWindow).length;
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
    // Match-context filters (Wave 6): one each when NARROWING (all views/genders).
    // Result and Result Condition are independent WHERE conditions, so each counts
    // on its own; "All" on Result / Result Condition / Stage is a no-narrowing
    // sentinel and never counts.
    if (resultFilterActive(s)) n++;
    if (tossResultFilterActive(s)) n++;
    if (tossDecisionFilterActive(s)) n++;
    if (inningsOrderFilterActive(s)) n++;
    if (stageFilterActive(s)) n++;
    if (resultConditionFilterActive(s)) n++;
    // Fielding SLICE conditions — plain mode only (inert under a matchup Vs).
    if (!matchupVsActive(s)) {
      if (fieldingPositionActive(s)) n++;
      if (fieldingKindActive(s)) n++;
      if (fieldingPhaseActive(s)) n++;
    }
    n += activeConditionCount(s.advanced);
    return n;
  }

  loadProfileOptions();
  sync();

  return { onShow, onHide, sync, activeCount, validate };
}
