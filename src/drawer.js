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
// calls store.set(...). Role/Hand/Bowling (+ Matchup Vs) are offered DATA-DRIVEN
// (owner 2026-08-03): shown wherever their profile/matchup data exists — men today,
// women when their profiles land — via filterAvailability, never a gender check.
// (R. Pos. is innings-derived, so it stays live on both views regardless.)

import { query } from "./db.js";
import {
  regularPositionsFilterActive,
  positionsFilterActive,
  oppositionFilterActive,
  eventFilterActive,
  venueFilterActive,
  fieldingPositionActive,
  fieldingPhaseActive,
  resultFilterActive,
  tossResultFilterActive,
  tossDecisionFilterActive,
  inningsNumberFilterActive,
  stageFilterActive,
  resultConditionFilterActive,
  matchupVsActive,
  opponentPlayerActive,
  effectiveNamespace,
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
  mountFieldingPhase,
  mountResult,
  mountTossResult,
  mountTossDecision,
  mountInningsNumber,
  mountStage,
  mountWindowPhase,
  mountWindowOvers,
  mountWindowBalls,
  mountWindowPlayer,
  mountOpponentPlayer,
  windowPhaseBallsAllowed,
} from "./drawerInnings.js";
import { mountSearchSelect } from "./searchSelect.js";
import { createAddPalette, paletteSkeletonHTML } from "./addPalette.js";
import { createPaletteGroupsBuilder } from "./paletteGroups.js";
import { createFilterAvailability, AVAIL_KEYS } from "./filterAvailability.js";
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

// The singleton (non-numeric) condition types. The profile/matchup-backed rows
// (Role / Batting hand / Bowling style / Matchup Vs / striker Batting position)
// are offered DATA-DRIVEN now (owner "remove the hardcode everywhere", 2026-08-03):
// isPresent gates them on filterAvailability, not the old `menOnly` gender flag —
// so they show wherever their data exists (men today; women when their profiles
// land) and stay absent otherwise. R5 Wave 1a (item 7)
// restructured the "+ Add condition" dropdown: the old standalone "Team" subset
// is dissolved into "Player" (Played for → "Team", Against opposition →
// "Opposition"); Bowling style is no longer a standalone dropdown entry (it is
// reachable via Role → Bowler, which exposes the fine bowling styles and writes
// the SAME profile.bowlingType); and R. Pos. relocates into the Basic-metrics
// group after "Innings". The PALETTE order/grouping is driven by the explicit
// 7-group taxonomy in buildPaletteGroups below (not by this array's order or the
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
  { key: "win_phase", label: "Phase", group: "Delivery", ballOnly: true },
  { key: "win_overs", label: "Over range", group: "Delivery", ballOnly: true },
  { key: "win_balls", label: "Ball range", group: "Delivery", ballOnly: true },
  { key: "win_player", label: "Player balls", group: "Delivery", ballOnly: true },
  // "Matchup (Vs)" (R3.2; relabelled Wave A1 item 1; R5-A #5 moved it to the
  // FIRST entry INSIDE the "Advanced metrics" optgroup, directly above Dot Ball
  // %): the matchup opponent selector, mirroring the toolbar's bonded Vs control
  // — both edit state.matchupVs, synced via the shared store (see
  // buildPaletteGroups). Leads this array too, so its applied row renders
  // first among the singleton rows (SINGLETON_TYPES order also drives applied-row
  // order). Availability is data-driven (matchupVsActive keys on state.dataAvail,
  // not gender — Group 3); for today's data that means men-only (matchup coverage
  // is ~0% for women, so the profile-backed Vs source is absent there).
  { key: "vs", label: "Matchup (Vs)", group: "Basic" },
  { key: "team", label: "Team", group: "Player" },
  { key: "opposition", label: "Opposition", group: "Player" },
  { key: "hand", label: "Batting hand", group: "Player" },
  { key: "bowling", label: "Bowling style", group: "Player" },
  { key: "role", label: "Role", group: "Player" },
  { key: "rpos", label: "R. Pos.", group: "Basic" },
  // Innings Number (filter-rejig Wave R2c): the REPLACEMENT for "Innings order" —
  // narrows to the innings the player batted/bowled in (1st/2nd white-ball, 1st–4th
  // red-ball; format-aware). A top-level scope filter (state.inningsNumber), both
  // disciplines + genders, every format — so no menOnly/ballOnly/matchup gate. Its
  // palette entry lives in Batting AND Bowling Basic Stats (see buildPaletteGroups).
  { key: "inn_num", label: "Innings Number", group: "Basic" },
  // Striker "Batting position" (R5-A #8): the MATCHUP-ONLY ball-level filter on
  // the batter-faced position (state.positions) — the one that powers the Bumrah-
  // vs-openers anchor. Split OUT of the R. Pos. row so it never auto-appears when
  // a Vs bucket is picked; its OWN addable "+ Add condition" entry, offered only
  // in matchup mode (isPresent gates it on matchupVsActive). Men-only in practice
  // (matchup coverage ~0% for women; matchupVsActive gates on data presence via
  // state.dataAvail, not gender — Group 3 — which for today's data is men-only).
  { key: "strikerpos", label: "Batting position", group: "Basic" },
  // Opponent-player head-to-head (pop-up Tab-2 T-1, owner decision 70): "subject X
  // vs opponent Y" — restricts the counted balls to those against ONE opponent
  // (subject batting ⇒ bowler_id = Y; subject bowling ⇒ batter_id = Y). BALL-ENGINE
  // ONLY (`ballOnly`) — needs per-delivery ids absent from the innings parquets, so
  // it is flag-gated exactly like the delivery-window rows above (never shows nor
  // auto-appears flag-OFF). NOT menOnly: bowler_id/batter_id exist for every
  // delivery, so — unlike the profile-backed vs bowling style / vs batting hand —
  // it works for both genders (matching the Ball Ranges group's gender-agnostic
  // gate). Its palette leaf lives in the Matchup (Vs) group; its editor is the
  // reused player-search (drawerInnings.js mountOpponentPlayer).
  { key: "vs_opp", label: "vs opponent player", group: "Basic", ballOnly: true },
  { key: "event", label: "Event", group: "Match" },
  // Stage (tournament round) moved OUT of the "Match context" group into "Match",
  // directly under Event and above Venue (owner, polish item 3) — it is a property
  // of the competition you are already picking, and its options now cross-filter by
  // the selected Event(s). Its position here also drives the APPLIED-row order, so
  // the Stage row renders next to the Event row it belongs with.
  { key: "mc_stage", label: "Stage", group: "Match" },
  { key: "venue", label: "Venue", group: "Match" },
  // Fielding SLICE conditions (fielding rebuild): the fielding metric's OWN dims
  // — narrow WHICH wicket-events the Catches/Stumpings/Run-outs/Dismissals-
  // Effected columns count. PLAIN mode only (fielding has no matchup grain);
  // isPresent gates them on !matchupVsActive. Not menOnly — fielding works for
  // both genders. They sit in the "Fielding" dropdown optgroup, alongside the
  // fielding metric conditions.
  { key: "fld_pos", label: "Dismissed position", group: "Fielding" },
  { key: "fld_phase", label: "Fielding phase", group: "Fielding" },
  // Match-context singletons (Wave 6): categorical WHERE filters keyed off the
  // MATCH's context. Both genders; work in batting, bowling AND matchup views
  // (no matchup gate), so — unlike the fielding slices — isPresent has no Vs
  // carve-out for them. They write their own top-level state key (result /
  // tossResult / tossDecision / stage). The former standalone
  // "Rain-affected matches" (mc_method) is gone — its method logic now lives in
  // the Result Condition sub-picker NESTED inside Result (state.resultCondition,
  // FIX B / polish item 4). Stage has moved up into the "Match" group (see above).
  { key: "mc_result", label: "Result", group: "Match context" },
  { key: "mc_toss_result", label: "Toss result", group: "Match context" },
  { key: "mc_toss_decision", label: "Toss decision", group: "Match context" },
];

// (The old per-group option-ORDER arrays — PLAYER_ADD_ORDER / MATCH_ADD_ORDER /
// FIELDING_SLICE_ADD_ORDER / MATCH_CONTEXT_ADD_ORDER — drove the native <select>'s
// optgroups and were retired with it in Wave R2: the search palette's order now
// lives in buildPaletteGroups' explicit 7-group taxonomy.)

// (The "metrics DELETED from the + Add condition picker" list — decision 68 —
// moved into src/paletteGroups.js with the taxonomy builder itself: T-F3,
// popup-tab2-build-plan.md. See that file for the full note.)

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

  // ── Data-driven filter availability (owner "remove the hardcode everywhere") ──
  // One instance per drawer: an async per-gender probe of matchup + profile DATA
  // existence, cached behind a SYNC getter the palette builder + isPresent read.
  // Replaces the old men-only gender gates — display/offer-logic only, no query
  // builder touched (numbers sacred). availabilityOnReady re-renders the singleton
  // rows + numeric groups (which host the palettes) once a probe resolves so the
  // offered set settles for the new scope. (availabilityOnReady is a hoisted
  // function declaration below — safe to reference here.)
  const availability = createFilterAvailability();
  // Warm the default gender's cache at mount (fires as soon as the DB is ready),
  // so the offered set is settled before the user ever opens "+ Add condition".
  availability.ensureLoaded(store.get(), availabilityOnReady);

  // ── Profile options + editors ──────────────────────────────────────────────
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
  // T-F3 dep for the (now-shared) palette taxonomy builder: reproduces the exact
  // guard buildPaletteGroups used inline before the extraction — kick off the
  // lazy load ONLY while nothing is cached yet (a failed load leaves
  // vsBowlingTypes null, so this retries on every subsequent call — unchanged
  // behaviour, just relocated behind a named dep).
  function ensureVsBowlingTypesLoaded() {
    if (!vsBowlingTypes) loadVsBowlingTypes().then((types) => { if (types && types.length) renderNumeric(store.get(), true); });
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
  const fieldingPhaseController = mountFieldingPhase(editorHosts.fld_phase, store, onChange, { embedded: true });
  // Match-context editors (Wave 6): each writes only its own state key.
  const resultController = mountResult(editorHosts.mc_result, store, onChange, { embedded: true });
  const tossResultController = mountTossResult(editorHosts.mc_toss_result, store, onChange, { embedded: true });
  const tossDecisionController = mountTossDecision(editorHosts.mc_toss_decision, store, onChange, { embedded: true });
  const inningsNumberController = mountInningsNumber(editorHosts.inn_num, store, onChange, { embedded: true });
  const stageController = mountStage(editorHosts.mc_stage, store, onChange, { embedded: true, onOptionsLoaded: onCascadeOptionsLoaded });
  // Delivery window (Wave 3, decision 67; UI-A REWORK): the four separate window
  // editors, each mounted into its own singleton row and writing its own piece of
  // state.deliveryWindow. Mounted unconditionally (their skeleton rows are built
  // like every singleton), but each only ever becomes VISIBLE / addable while the
  // ball engine is active (+ its format gate) — see isPresent + buildPaletteGroups.
  // Flag-OFF they stay hidden, inert rows that never write state.deliveryWindow.
  const winPhaseController = mountWindowPhase(editorHosts.win_phase, store, onChange, { embedded: true });
  const winOversController = mountWindowOvers(editorHosts.win_overs, store, onChange, { embedded: true });
  const winBallsController = mountWindowBalls(editorHosts.win_balls, store, onChange, { embedded: true });
  const winPlayerController = mountWindowPlayer(editorHosts.win_player, store, onChange, { embedded: true });
  // Opponent-player head-to-head (Tab-2 T-1, decision 67 family / decision 70):
  // reuses the shared player-search (mountOpponentPlayer). Mounted unconditionally
  // like every singleton editor; its row is only ever visible/addable on the ball
  // engine (isPresent's ballOnly gate). Writes state.opponentPlayer; db.js turns
  // that into the base-CTE ball predicate on Search.
  const opponentController = mountOpponentPlayer(editorHosts.vs_opp, store, onChange, { embedded: true });

  // ── "This will come back empty" notice (owner ruling) ──────────────────────
  // Since a dead-end pick is now KEPT and greyed rather than reset, a search can
  // legitimately return no rows. When one filter's ENTIRE selection is currently
  // impossible, that filter ALONE guarantees an empty result — a fact each picker
  // already has from its own option list, so this costs no extra query. Say so
  // plainly, name the control, and leave Search fully enabled: it informs, it
  // never blocks. Only these five report; the fixed-vocabulary pickers (Result,
  // Toss…, Innings Number) have no cross-filtered list and can't go dead this way.
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
      // Opponent-player (Tab-2 T-1): present when an opponent is picked. Gated on
      // the ball engine too (belt-and-suspenders — flag-OFF opponentPlayer is
      // always null and the row is ballOnly-hidden anyway).
      case "vs_opp": return ballEngineEnabled() && Boolean(s.opponentPlayer && s.opponentPlayer.id);
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
      // Innings Number (Wave R2c): present when it has a value (both disciplines).
      case "inn_num":
        return (s.inningsNumber || []).length > 0;
      case "strikerpos":
        return (s.positions || []).length > 0;
      case "team": return (s.teams || []).length > 0;
      case "opposition": return (s.opposition || []).length > 0;
      case "event": return (s.event || []).length > 0;
      case "venue": return (s.venue || []).length > 0;
      // Fielding SLICE conditions: present when their list has a value.
      case "fld_pos": return Boolean(s.fielding && (s.fielding.positions || []).length > 0);
      case "fld_phase": return Boolean(s.fielding && (s.fielding.phases || []).length > 0);
      // Match-context singletons (Wave 6): present when their value is set. Result
      // (FIX A) and Stage (polish item 3) are present once their condition is added
      // — each seeded to ["all"] (the "All" default) — so length > 0 covers both All
      // and specific picks; Result Condition (state.resultCondition) has no separate
      // row (it nests inside Result).
      case "mc_result": return (s.result || []).length > 0;
      case "mc_toss_result": return (s.tossResult || []).length > 0;
      case "mc_toss_decision": return (s.tossDecision || []).length > 0;
      case "mc_stage": return (s.stage || []).length > 0;
      default: return false;
    }
  }

  const FIELDING_SLICE_KEYS = new Set(["fld_pos", "fld_phase"]);

  // Profile/matchup-backed singleton rows are offered only where their DATA exists
  // in the current scope (data-driven — owner "remove the hardcode everywhere",
  // 2026-08-03; replaces the old `menOnly && gender === "female"` gate). Others
  // are always eligible. "vs"/"strikerpos" resolve by discipline (bowling-style
  // vs batting-hand matchup source). SYNC read of the async availability cache
  // (optimistic true until loaded — see filterAvailability.js).
  function singletonDataAvailable(key, s) {
    switch (key) {
      case "role": return availability.isAvailable("profileRole", s);
      case "hand": return availability.isAvailable("profileHand", s);
      case "bowling": return availability.isAvailable("profileBowling", s);
      case "vs":
      case "strikerpos":
        return availability.isAvailable(s.discipline === "batting" ? "vsBowlingStyle" : "vsBattingHand", s);
      default: return true;
    }
  }

  // Re-render the singleton rows + numeric groups (the palette hosts) once an
  // availability probe resolves, so a scope's offered set settles. Hoisted so the
  // deps/availability wiring above can reference it.
  function availabilityOnReady() {
    syncSingletonRows();
    renderNumeric(store.get(), true);
  }

  function isPresent(t, s) {
    // Data-driven availability gate (see singletonDataAvailable) — replaces the old
    // men-only gender hardcode. For men everything is available (unchanged); women's
    // profile/matchup rows stay hidden because their data is absent (and their state
    // carries no value anyway).
    if (!singletonDataAvailable(t.key, s)) return false;
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
      case "vs_opp": store.set({ opponentPlayer: null }); break;
      case "role": setProfile({ roleGroup: null, roleSub: null }); break;
      case "hand": setProfile({ battingHand: null }); break;
      case "bowling": setProfile({ bowlingType: null }); break;
      case "vs": store.set({ matchupVs: null }); break;
      case "rpos": store.set({ regularPositions: [] }); break;
      case "inn_num": store.set({ inningsNumber: [] }); break;
      case "strikerpos": store.set({ positions: [] }); break;
      case "team": store.set({ teams: [] }); break;
      case "opposition": store.set({ opposition: [] }); break;
      case "event": store.set({ event: [], eventSeasons: {} }); break; // Wave 6 pt2: drop season narrowing too
      case "venue": store.set({ venue: [] }); break;
      case "fld_pos": store.set({ fielding: { ...(store.get().fielding || {}), positions: [] } }); break;
      case "fld_phase": store.set({ fielding: { ...(store.get().fielding || {}), phases: [] } }); break;
      // Removing Result also removes its nested Result Condition (FIX B).
      case "mc_result": store.set({ result: [], resultCondition: [] }); break;
      case "mc_toss_result": store.set({ tossResult: [] }); break;
      case "mc_toss_decision": store.set({ tossDecision: [] }); break;
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

  // (stripOutPrefix moved into src/paletteGroups.js with the taxonomy builder —
  // T-F3.)

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
  // Innings Number ▸ (Wave R2c): a variant pre-selects ONE innings number (the user
  // can tick more in the revealed row) — equivalent to ticking it in the editor.
  const preselectInningsNumber = (n) => () => store.set({ inningsNumber: [n] });

  // ── 7-group palette taxonomy — src/paletteGroups.js (Wave A · T-F3) ───────────
  // buildPaletteGroups itself (the group/leaf/family tree) moved to the shared
  // module so a later wave can mount the SAME taxonomy in the player pop-up with
  // a reduced surface (`surface:"popup"`); see that file's header for the full
  // note. This closure supplies its OWN instance state — isPresent/SINGLETON_TYPES
  // (singleton presence), pickSingleton/pickMetric (the store mutations), the
  // preselect closures, and the Vs-bowling-types cache/loader — exactly the same
  // values buildPaletteGroups read as free variables before the extraction, so
  // the taxonomy it returns for `surface:"leaderboard"` is byte-identical.
  const buildPaletteGroups = createPaletteGroupsBuilder({
    isPresent, SINGLETON_TYPES,
    pickSingleton, pickMetric,
    preselectPhase, preselectFielding, preselectMatchupVs, preselectEdge, preselectInningsNumber,
    getVsBowlingTypes: () => vsBowlingTypes,
    ensureVsBowlingTypesLoaded,
    // Data-driven availability (owner "remove the hardcode everywhere") — the
    // profile leaves + Matchup Vs family are offered iff their data exists.
    isFilterAvailable: (key, s) => availability.isAvailable(key, s),
    ensureFilterAvailabilityLoaded: (s) => availability.ensureLoaded(s, availabilityOnReady),
  });

  // ── Palette component (portal + search + ▸ drill-down) — src/addPalette.js ────
  // The generic search-palette machinery (leak-free portal, list build,
  // search/highlight, ▸ drill-down, open/close, "only one open at a time") was
  // extracted to src/addPalette.js in Wave R3 so the player pop-up drawer can
  // mount the SAME component. This surface supplies its own 7-group taxonomy via
  // buildPaletteGroups (now src/paletteGroups.js), pinned to `surface:"leaderboard"`
  // — the leaderboard's full taxonomy, unchanged. Each leaf's run() closure still
  // fires pickSingleton / pickMetric here, so the palette — and every number it
  // produces — is byte-identical to the pre-extraction inline version (numbers
  // sacred; no query path lives in addPalette.js or paletteGroups.js).
  // `palette.mountAddPalette(el)` builds + wires one palette per numeric group
  // card; `palette.closeCurrent()` closes whichever is open before a rebuild (a
  // portaled-open panel would otherwise orphan on <body>).
  const palette = createAddPalette({
    buildGroups: (gi) => buildPaletteGroups(store.get(), gi, { surface: "leaderboard" }),
  });

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
    fieldingPhaseController.sync();
    resultController.sync();
    tossResultController.sync();
    tossDecisionController.sync();
    inningsNumberController.sync();
    stageController.sync();
    winPhaseController.sync();
    winOversController.sync();
    winBallsController.sync();
    winPlayerController.sync();
    opponentController.sync();
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
      // Data-driven availability signature (owner "remove the hardcode everywhere")
      // — replaces the old `women: gender === "female"` field. Rebuilds the numeric
      // groups (palette hosts) whenever the offered profile/matchup set flips, i.e.
      // on a gender switch AND when an availability probe resolves. Gender is the
      // probe axis, so this still changes on the men↔women switch it used to catch.
      avail: AVAIL_KEYS.map((k) => availability.isAvailable(k, s)),
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
    // Parametrised threshold metrics (R2b Phase 2: Innings Score ≥ N, Wicket Hauls
    // ≥ N). These carry a `paramTemplate` + `param` descriptor (metrics.js): the
    // user first sets the threshold N (an INSIDE-the-metric bar, e.g. "≥ 50 runs"),
    // then the normal operator + value applies to the resulting COUNT of innings.
    // The N lives on cond.n (inside state.advanced, so it serializes + re-lights
    // Search like every other condition field). ADDITIVE: an unset cond.n falls
    // back to the metric's default sqlExpression in table.js — byte-identical.
    const rowMetric = getMetric(cond.metricKey, ns);
    const paramMeta = rowMetric && rowMetric.paramTemplate && rowMetric.param ? rowMetric.param : null;
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
    // Param metrics: drop the "≥ N" placeholder from the label (it becomes the live
    // N box) and render "<base> ≥ [N] <unit>" before the operator. Default-show
    // param.default while cond.n is unset — consistent, since table.js's
    // paramSqlExpression falls back to that same default when cond.n is absent.
    const rawLabel = metricLabel(cond.metricKey, ns, formats);
    const typeLabel = paramMeta ? rawLabel.replace(/\s*≥\s*N\s*$/, "") : rawLabel;
    const paramField = paramMeta
      ? `<span class="cond-row__and">≥</span>
           <input type="number" min="${paramMeta.min ?? 0}" step="${paramMeta.step ?? 1}" class="input cond-row__value-input cond-row__n-input" data-role="n" value="${escAttr(cond.n ?? paramMeta.default)}" aria-label="${escAttr(paramMeta.label || "threshold")} threshold" title="Threshold (${escAttr(paramMeta.label || "")})" />
           ${paramMeta.label ? `<span class="cond-row__and">${escHtml(paramMeta.label)}</span>` : ""}`
      : "";
    return `
      <div class="cond-row cond-row--metric ${hasError ? "cond-row--error" : ""}" data-gi="${gi}" data-ci="${ci}">
        <div class="cond-row__line">
          <div class="cond-row__main">
            <span class="cond-row__type">${escHtml(typeLabel)}</span>
            ${paramField}
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
          ${paletteSkeletonHTML(gi)}
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
    palette.closeCurrent();
    numericEl.innerHTML = cards + addGroupBtn;
    wireNumeric();
  }

  function wireNumeric() {
    const groups = realGroups(store.get());

    // Per-group "+ Add condition" search palettes (one per group card, by data-gi).
    // Each builds its taxonomy from the live state and fires pickSingleton / pickMetric.
    numericEl.querySelectorAll('[data-role="add-palette"]').forEach((el) => palette.mountAddPalette(el));

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

      // v1 / v2 (values) AND n (the R2b param threshold): all edit cond[role].
      // A param metric's N (data-role="n") re-uses this handler verbatim —
      // cond.n = input.value, persisted in state.advanced (serialized), and the
      // error-clear below keys off conditionHasError (which validates v1, not n),
      // so an N edit never spuriously clears/blocks the row.
      rowEl.querySelectorAll('[data-role="v1"],[data-role="v2"],[data-role="n"]').forEach((input) => {
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
    // Warm the data-driven availability cache for the current gender (idempotent —
    // re-probes only when gender changes), so the offered filter set is settled by
    // the time the user opens the "+ Add condition" palette.
    availability.ensureLoaded(s, availabilityOnReady);
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
    // Opponent-player head-to-head (Tab-2 T-1): one when active (ball engine only).
    if (opponentPlayerActive(s)) n++;
    if ((s.teams || []).length > 0) n++;
    // Profile filters count when SET (data-driven, not gender-hardcoded — owner
    // "remove the hardcode everywhere"): women's state carries no profile value
    // (cleared on gender switch; the filters aren't offered), so this adds 0 for
    // them exactly as the old `gender !== "female"` guard did.
    {
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
    if (inningsNumberFilterActive(s)) n++;
    if (stageFilterActive(s)) n++;
    if (resultConditionFilterActive(s)) n++;
    // Fielding SLICE conditions — plain mode only (inert under a matchup Vs).
    if (!matchupVsActive(s)) {
      if (fieldingPositionActive(s)) n++;
      if (fieldingPhaseActive(s)) n++;
    }
    n += activeConditionCount(s.advanced);
    return n;
  }

  loadProfileOptions();
  sync();

  return { onShow, onHide, sync, activeCount, validate };
}
