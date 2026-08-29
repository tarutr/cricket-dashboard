// src/drawer.js
//
// The "Advanced Filters" condition builder — the ONE grouped condition builder
// that is the entire second section of the Filters popup (owner task 1B-2). The
// old separate "Player" section is gone; its filters (Role / Batting hand /
// Bowling style) fold in here as condition types, alongside Team
// (Played for / Against opposition), Match (Event / Venue), and the numeric
// stat conditions (split into Basic / Advanced metric groups).
//
// Shape: a "+ Add condition" grouped dropdown (optgroups: Player · Team · Match
// · Basic metrics · Advanced metrics) appends condition ROWS. Two kinds of row:
//   • SINGLETON rows (Role/Hand/Bowling/Team/Opposition/Event/Venue) —
//     at most one each; their value lives in its own state key (profile.* /
//     teams / opposition / event / venue). Built once as a
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

import { query } from "./db.js";
import {
  positionsFilterActive,
  oppositionFilterActive,
  eventFilterActive,
  venueFilterActive,
  fieldingPositionActive,
  resultFilterActive,
  tossResultFilterActive,
  tossDecisionFilterActive,
  potmYNFilterActive,
  inningsNumberFilterActive,
  stageFilterActive,
  resultConditionFilterActive,
  matchupVsActive,
  matchupVsAxes,
  opponentPlayerActive,
  effectiveNamespace,
  filterGroupOp,
} from "./state.js";
import { deliveryWindowTokens, withDeliveryWindowPiece } from "./deliveryWindow.js";
import { ballEngineEnabled } from "./config.js";
import { getMetric, matchupBucketLabel, bowlingStyleDisplayLabel, metricDisplayLabel, metricInputStep } from "./metrics.js";
import {
  OPERATORS,
  activeConditionCount,
  conditionHasError,
  addConditionToGroup,
  removeGroup,
  setGroupOp,
  setFilterGroupOp,
  removeConditionAt,
  isBowlingFiguresCondition,
} from "./advanced.js";
import {
  mountBattingPosition,
  battingPositionFilterLabel,
  mountOpposition,
  mountTeam,
  mountEvent,
  mountVenue,
  mountCity,
  mountSeason,
  mountFieldingPosition,
  mountResult,
  mountTossResult,
  mountTossDecision,
  mountPotmYN,
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
import { createFieldingDimsController } from "./fieldingDimsDrawer.js";
import { createFilterAvailability, AVAIL_KEYS } from "./filterAvailability.js";
import { escHtml, escAttr } from "./html.js";

// Display order for the profile-filter option lists.
const ROLE_GROUP_ORDER = ["Batter", "Allrounder", "Bowler"];
const ROLE_SUB_ORDER = ["Opening", "Top-order", "Middle-order", "Wicketkeeper", "Batting allrounder", "Bowling allrounder"];
const BATTING_HAND_ORDER = ["Right-hand bat", "Left-hand bat"];
// Pace-first (owner #9): Fast · Fast-medium · Medium-fast · Medium ·
// Slow-medium, then Spin: Off-spin · Leg-spin · Slow left-arm orthodox ·
// Left-arm wrist-spin. Display order only — mirrors table.js's
// BOWLING_TYPE_PREFERENCE and columnsPicker.js's FC_BSTYLE_VALUES.
const BOWLING_TYPE_ORDER = [
  "Fast", "Fast-medium", "Medium-fast", "Medium", "Slow-medium",
  "Off-spin", "Leg-spin", "Slow left-arm orthodox", "Left-arm wrist-spin",
];
// Bowling hand (owner #8): data-driven values are "Right" / "Left" only.
const BOWLING_HAND_ORDER = ["Right", "Left"];

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
// "Opposition"); Bowling style IS a standalone dropdown entry (R6 cleanup:
// removed the redundant nested bowling-style sub-picker that used to also live
// inside Role → Bowler — Role stays purely role, profile.bowlingType is set only
// here). The PALETTE order/grouping is driven by the explicit
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
  { key: "win_overs", label: "Over Range", group: "Delivery", ballOnly: true },
  { key: "win_balls", label: "Team Ball Range", group: "Delivery", ballOnly: true },
  { key: "win_player", label: "Batter/Bowler Ball Range", group: "Delivery", ballOnly: true },
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
  // "vs PotMs" (decision 81 + 83 Fork 2): the cross-board vs-Player-of-the-Match axis
  // of the composite state.matchupVs (dim `potm`, bucket value "1"). A VALUELESS Matchup-
  // lane row — adding it IS the filter (pickSingleton sets the potm axis); no editor.
  // BALL-ENGINE ONLY (`ballOnly` — the reconstructed vs_potm column exists only there),
  // offered iff the board's matchup data exists (data-driven; men today).
  { key: "vs_potm", label: "vs PotMs", group: "Basic", ballOnly: true },
  { key: "team", label: "Team", group: "Player" },
  { key: "opposition", label: "Opposition", group: "Player" },
  { key: "hand", label: "Batting Hand", group: "Player" },
  { key: "bowling", label: "Bowling Style", group: "Player" },
  // Bowling hand (owner #8, columns rejig wave C): dedicated `bowling_arm`
  // profile column ("Right"/"Left"). Mirrors the "bowling" row exactly.
  { key: "bowlingHand", label: "Bowling Hand", group: "Player" },
  { key: "role", label: "Role", group: "Player" },
  // PotM (Y/N) (Wave D — TASK B): a fixed Yes/No categorical singleton (state.potmYN)
  // — "Won a Player of the Match" vs "Never Player of the Match" in scope. Sits in the
  // Player Profile group beside the PotM Count filter. Both genders, both disciplines
  // (a whole-match award), every format — so no menOnly/ballOnly/matchup/discipline
  // gate. buildQuery turns exactly-one selection into a HAVING gate on pom_cte.
  { key: "potm_yn", label: "PotM (Y/N)", group: "Player" },
  // Innings Number (filter-rejig Wave R2c): the REPLACEMENT for "Innings order" —
  // narrows to the innings the player batted/bowled in (1st/2nd white-ball, 1st–4th
  // red-ball; format-aware). A top-level scope filter (state.inningsNumber), both
  // disciplines + genders, every format — so no menOnly/ballOnly/matchup gate. Its
  // palette entry lives in Batting AND Bowling Basic Stats (see buildPaletteGroups).
  { key: "inn_num", label: "Innings Number", group: "Basic" },
  // "Batting position" (position rework 2026-08-14): the ball/innings-level filter
  // on batting_position (state.positions) — the one that powers the Bumrah-vs-openers
  // anchor. Its OWN addable "+ Add condition" entry, offered in PLAIN batting AND any
  // matchup (isPresent gates it on discipline batting OR matchupVsActive); hidden in
  // plain bowling, whose view has no batting_position column.
  { key: "strikerpos", label: "Batting Position", group: "Basic" },
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
  { key: "vs_opp", label: "vs Opponent Player", group: "Basic", ballOnly: true },
  { key: "event", label: "Event", group: "Match" },
  // Stage (tournament round) moved OUT of the "Match context" group into "Match",
  // directly under Event and above Venue (owner, polish item 3) — it is a property
  // of the competition you are already picking, and its options now cross-filter by
  // the selected Event(s). Its position here also drives the APPLIED-row order, so
  // the Stage row renders next to the Event row it belongs with.
  { key: "mc_stage", label: "Stage", group: "Match" },
  { key: "venue", label: "Venue", group: "Match" },
  // City / Season (City & Season everywhere, 2026-08-16): standalone match-level
  // singletons mirroring Event/Venue — state.city / state.season, both genders,
  // both disciplines, every format. Their palette leaves live in the Match Details
  // group (buildPaletteGroups). NOT added to FIELDING_BOARD_SINGLETONS — the
  // fielding board offers City/Season as its OWN dims (fieldingDims.js), so these
  // top-level singleton rows never surface there.
  { key: "city", label: "City", group: "Match" },
  { key: "season", label: "Season", group: "Match" },
  // Fielding SLICE conditions (fielding rebuild): the fielding metric's OWN dims
  // — narrow WHICH wicket-events the Catches/Stumpings/Run-outs/Dismissals-
  // Effected columns count. PLAIN mode only (fielding has no matchup grain);
  // isPresent gates them on !matchupVsActive. Not menOnly — fielding works for
  // both genders. They sit in the "Fielding" dropdown optgroup, alongside the
  // fielding metric conditions.
  { key: "fld_pos", label: "Dismissed Batter's Position", group: "Fielding" },
  // Match-context singletons (Wave 6): categorical WHERE filters keyed off the
  // MATCH's context. Both genders; work in batting, bowling AND matchup views
  // (no matchup gate), so — unlike the fielding slices — isPresent has no Vs
  // carve-out for them. They write their own top-level state key (result /
  // tossResult / tossDecision / stage). The former standalone
  // "Rain-affected matches" (mc_method) is gone — its method logic now lives in
  // the Result Condition sub-picker NESTED inside Result (state.resultCondition,
  // FIX B / polish item 4). Stage has moved up into the "Match" group (see above).
  { key: "mc_result", label: "Match Result", group: "Match context" },
  { key: "mc_toss_result", label: "Toss Result", group: "Match context" },
  { key: "mc_toss_decision", label: "Toss Decision", group: "Match context" },
];

// (The old per-group option-ORDER arrays — PLAYER_ADD_ORDER / MATCH_ADD_ORDER /
// FIELDING_SLICE_ADD_ORDER / MATCH_CONTEXT_ADD_ORDER — drove the native <select>'s
// optgroups and were retired with it in Wave R2: the search palette's order now
// lives in buildPaletteGroups' explicit 7-group taxonomy.)

// Chunk 5 · Phase 2 · Wave D — which LANE each singleton row belongs to, so the
// applied rows can render as one list PER lane (Player Filters / Scope Filters),
// each under its own always-visible Match-all/any toggle. This mirrors the
// owner-ruled Phase-1 taxonomy split (paletteGroups.js GROUP_DEFAULT_LANE): the
// Player Profile singletons are the only player-lane ones; the Matchup "Vs" selector
// is its OWN third lane now (decision 80 — the "define the opponent" home; see the
// matchup lane markup above); everything else (Team, Opposition, Event/Stage/Venue/
// City/Season, Match/Toss Result, Innings Number, Batting position, Ball Ranges,
// Dismissed-batter position) is Scope. Numeric metric conditions are always
// player-lane (all metric groups are tagged "player"). Display-only — a row's lane
// never changes WHAT its editor writes or what the query returns; the OR toggle it
// lands under drives state.filterMatch, which the engine (Waves A–E) already reads.
// (The matchup lane has NO Match all/any toggle — a matchup Vs is a single mode, not
// an AND/OR-able condition; it always ANDs with scope, decision 47a.)
const PLAYER_LANE_SINGLETONS = new Set(["role", "hand", "bowling", "bowlingHand", "potm_yn"]);
// The Matchup lane (decision 83 Fork 2, 2026-08-29): the "define the opponent" rows,
// added from the third "+ Add ▸ Matchup" dropdown and rendered OUTSIDE the Player+Scope
// group card, always-AND. `vs` = the style/hand axis; `vs_potm` = the PotMs axis; `vs_opp`
// = the opponent-player head-to-head (moved here from Scope). `strikerpos` joins on the
// bowling board only (see singletonLane).
const MATCHUP_LANE_SINGLETONS = new Set(["vs", "vs_potm", "vs_opp"]);
// "strikerpos" (Batting position) is the one DISCIPLINE-AWARE lane (owner ruling,
// chip-lane fix 2026-08-27; extended decision 83 Fork 2): on the batting board it's the
// subject's OWN position → "Player Filters"; on the bowling board it filters the OPPONENT
// batter's position → "vs Opponent Batting Position", a MATCHUP axis, so it lands in the
// Matchup lane there. Every other singleton's lane is static (unaffected). `discipline`
// defaults to "batting" so the very first, pre-store-read caller (the skeleton HTML build
// below, before any state exists) resolves the same way the default state does.
const singletonLane = (key, discipline = "batting") => {
  if (key === "strikerpos") return discipline === "batting" ? "player" : "matchup";
  return MATCHUP_LANE_SINGLETONS.has(key) ? "matchup" : PLAYER_LANE_SINGLETONS.has(key) ? "player" : "scope";
};

// (The "metrics DELETED from the + Add condition picker" list — decision 68 —
// moved into src/paletteGroups.js with the taxonomy builder itself: T-F3,
// popup-tab2-build-plan.md. See that file for the full note.)

// #26 (audit3 §c, "Escape strands the composer/filter value list"): shared
// capture-phase document Escape guard for this file's searchSelect.js panels
// (the six mountSearchSelect calls below — Role/Detailed role/Batting hand/
// Bowling style/Bowling hand/Matchup Vs). Mirrors columnsPicker.js's
// onSearchPickerEscape and addPalette.js's own document Escape handler: once
// the user clicks a row (moving focus off the widget's own filter box),
// Escape skips searchSelect.js's onFilterKeydown entirely and falls straight
// through to the Filters popup's own document-level Escape handler (main.js),
// which hides the popup but leaves this portaled panel floating over the
// table. Guards on the toggle's OWN aria-expanded (no isOpen getter on the
// handle) so it only acts — and only stops the popup's handler — while the
// panel is actually open; a second Escape still closes the popup as normal.
// Every one of these six pickers is mounted ONCE here at drawer boot and
// lives for the app's lifetime (mountFilterDrawer itself is called once from
// main.js's boot() — never re-rendered/destroyed), so — unlike columnsPicker's
// transient composer editor — this listener needs no re-mount teardown: it is
// created once, in lockstep with its (permanent) widget.
function wireSearchPickerEscape(hostEl, handle) {
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      const toggleBtn = hostEl.querySelector(".search-select__toggle");
      if (!toggleBtn || toggleBtn.getAttribute("aria-expanded") !== "true") return;
      handle.close({ focusToggle: true });
      e.stopPropagation();
    },
    true
  );
}

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
  // The singleton condition rows are built once (their editors / option caches /
  // portal wiring must survive every numeric rebuild) but now render split BY LANE
  // (singletonLane) so each lane reads as one applied-filter list.
  const singletonRowHTML = (t) => `
      <div class="cond-row" data-cond="${t.key}" hidden>
        <div class="cond-row__line">
          <div class="cond-row__main">
            <span class="cond-row__type" data-role="type-label-${t.key}">${escHtml(t.label)}</span>
            <div class="cond-row__value" data-role="editor-${t.key}"></div>
          </div>
          <button type="button" class="icon-btn cond-row__remove" data-remove="${t.key}" title="Remove condition">&times;</button>
        </div>
      </div>`;
  // Built once, before the popup has ever been opened. Way A review fix (decision
  // 83, 2026-08-29): every added condition renders as ONE continuous list in the
  // order the user ADDED them (syncCondOrder below), NOT split into Player then Scope
  // blocks — so a SINGLE container holds every singleton row, and the numeric + fielding
  // -dim blocks join it as their own ordered slots. The Matchup-lane rows (vs / vs_potm /
  // vs_opp, + strikerpos on bowling) get their skeleton HERE too; syncMatchupRows then
  // RE-PARENTS the present ones into the separate Matchup <section> below (a row's editor
  // host moves with it, so nothing is re-mounted). Building them here keeps a SINGLE
  // build site + a single remove-wiring loop, and lets strikerpos live in this list on
  // the batting board (Player lane) and the Matchup lane on the bowling board.
  const listSingletonsHTML = () => SINGLETON_TYPES.map(singletonRowHTML).join("");

  // Way A (decision 83) — ONE group card, ONE operator. The two per-lane "Match all /
  // Match any" toggles (Player / Scope) collapse into a SINGLE group operator over ALL
  // Player + Scope conditions (bound to setFilterGroupOp; read via filterGroupOp). Review
  // fix (2026-08-29): the card shows every added condition as ONE undifferentiated list in
  // the order the user ADDED them — no Player/Scope split, per-kind title, or gap (owner:
  // "if I choose a player scope then a filter scope then a player scope, it needs to show
  // in that order without gaps"). A SINGLE `cond-rows` container holds every singleton row,
  // plus the numeric block and the fielding-dim block as their own slots; syncCondOrder
  // re-appends the present slots in activation order (every singleton controller and
  // numericEl still target their rows by data-role, so the merge is DOM-only, machinery
  // intact). The two "+ Add condition" dropdowns — "Player Filters" and "Scope Filters" —
  // sit side-by-side in a row ABOVE the Match-all/any line and the list (renderAddRow),
  // built so Matchup can join as a third dropdown in Task 3 without rework. The numeric
  // metric GROUP still KEEPS its own per-group Match-all/any toggle once it has ≥2
  // conditions (owner ruling Q1 — that toggle is the numeric block's own operator,
  // setGroupOp, distinct from this single group operator). The Matchup lane stays where it
  // is (Task 3 re-houses it) — always-ANDs, outside the group (decision 80 / Fork 2).
  const groupOpHead = `
      <div class="cond-group-one__head">
        <span class="cond-group-one__match-label">Match</span>
        <div class="segmented segmented--small" data-role="filter-group-op">
          <button type="button" class="segmented__btn" data-value="AND">All</button>
          <button type="button" class="segmented__btn" data-value="OR">Any</button>
        </div>
        <span class="cond-group-one__match-label">of the conditions below</span>
      </div>`;
  advancedHost.innerHTML = `
    <div class="cond-builder">
      <section class="cond-group-one" data-role="filter-group">
        <div class="cond-group-one__addrow" data-role="add-row">
          <div class="cond-lane-bar" data-role="player-add"></div>
          <div class="cond-lane-bar" data-role="scope-add"></div>
          <!-- Matchup "+ Add" dropdown (decision 83 Fork 2) — the THIRD dropdown, so the
               row reads Player | Scope | Matchup. Its picks add rows to the separate Matchup
               <section> below (NOT this group card). Hidden entirely when the board has no
               matchup data to offer (renderAddRow). -->
          <div class="cond-lane-bar" data-role="matchup-add"></div>
        </div>
        ${groupOpHead}
        <!-- Way A review fix (decision 83, 2026-08-29): ONE undifferentiated condition
             list — every added condition (Player + Scope singletons, the numeric block,
             and the fielding-dim block) is a direct child here, rendered in the order the
             user added them (syncCondOrder), with NO Player/Scope split, heading, or gap.
             The numeric + fielding-dim blocks start hidden and stay hidden while empty so a
             visible-but-empty flex child never leaves a stray gap. -->
        <div class="cond-group-one__list" data-role="cond-rows">
          ${listSingletonsHTML()}
          <div class="cond-builder__numeric" data-role="numeric-rows" hidden></div>
          <!-- Fielding board dim rows (3.2b2): one inline condition row per fielding dim
               (Wicket type / Bowler style / Phase / …), shown only while the Fielding
               discipline is active. Owned by the fielding-dim controller below (they narrow
               WHICH wicket-events count). Positioned as one ordered slot by syncCondOrder. -->
          <div class="cond-builder__rows" data-role="fielding-dim-rows" hidden></div>
        </div>
      </section>
      <!-- ── Matchup lane (decision 83 Fork 2, 2026-08-29) ────────────────────────
           A THIRD lane, peer to Player Filters / Scope Filters, added from the
           "+ Add ▸ Matchup" dropdown in the add-row above. Each picked axis becomes a
           CONDITION ROW here (same visual/interaction as a Player/Scope row) with its
           inline value control — vs Bowling Style / vs Batting Hand (the 'vs' row's
           style/hand menu), vs Opponent Batting Position (strikerpos), vs Opponent Player
           (vs_opp), and vs PotMs (a valueless row). All axes AND (decision 47a/81A) and
           carry NO Match-all/any toggle — the group card's operator governs Player/Scope
           only. The rows' skeletons are built in the group card's list above and
           RE-PARENTED here by syncMatchupRows (their editors move with them). The section
           hides when it holds no rows (renderMatchupSection). state.matchupVs stays the
           SAME state the (migrated) results-toolbar Vs <select> writes — kept in sync via
           the shared store; buildMatchupQuery is untouched (numbers sacred). -->
      <section class="cond-lane cond-lane--matchup" data-lane="matchup" hidden>
        <div class="cond-lane__head">
          <span class="cond-lane__title">Matchup</span>
        </div>
        <div class="cond-lane__list" data-role="matchup-rows"></div>
      </section>
    </div>`;

  const rowEls = {};
  const typeLabelEls = {};
  const editorHosts = {};
  for (const t of SINGLETON_TYPES) {
    rowEls[t.key] = advancedHost.querySelector(`[data-cond="${t.key}"]`);
    typeLabelEls[t.key] = advancedHost.querySelector(`[data-role="type-label-${t.key}"]`);
    editorHosts[t.key] = advancedHost.querySelector(`[data-role="editor-${t.key}"]`);
  }
  // Matchup lane (decision 83 Fork 2) refs — the third lane's section + its rows list.
  // The rows themselves are singleton skeletons re-parented in by syncMatchupRows;
  // renderMatchupSection() toggles the section's visibility.
  const matchupLaneEl = advancedHost.querySelector('[data-lane="matchup"]');
  const matchupRowsListEl = advancedHost.querySelector('[data-role="matchup-rows"]');
  const numericEl = advancedHost.querySelector('[data-role="numeric-rows"]');
  // The single condition list (Way A review fix, decision 83) — every present slot
  // (singleton rows, the numeric block, the fielding-dim block) is re-appended here in
  // activation order by syncCondOrder below.
  const condRowsListEl = advancedHost.querySelector('[data-role="cond-rows"]');
  const fieldingDimRowsEl = advancedHost.querySelector('[data-role="fielding-dim-rows"]');

  // ── Single group operator (Way A, decision 83) ──────────────────────────────
  // ONE "Match all / Match any" over ALL Player + Scope conditions, replacing the two
  // per-lane toggles. ALWAYS visible (no hidden-until-2-conditions). Bound to
  // setFilterGroupOp (which writes `group` and keeps the legacy scope/player mirror
  // equal to it, so the not-yet-migrated readers stay consistent) and read back via
  // filterGroupOp. At the default "AND" the OR engine takes its byte-identical branch,
  // so the anchors are untouched. syncGroupOpToggle reflects the current op onto the
  // segmented buttons (lives in the stable skeleton, never rebuilt by renderNumeric).
  const filterGroupOpEl = advancedHost.querySelector('[data-role="filter-group-op"]');
  if (filterGroupOpEl) {
    filterGroupOpEl.querySelectorAll(".segmented__btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.classList.contains("is-active")) return; // no-op re-click (keeps Search dirty-key honest)
        setFilterGroupOp(store, btn.dataset.value);
        syncGroupOpToggle();
        onChange();
      });
    });
  }
  function syncGroupOpToggle() {
    if (!filterGroupOpEl) return;
    const op = filterGroupOp(store.get().filterMatch) === "OR" ? "OR" : "AND";
    filterGroupOpEl.querySelectorAll(".segmented__btn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.value === op);
    });
  }

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
  let profileOptions = { roleGroups: [], subByGroup: {}, bowlingTypes: [], battingHands: [], bowlingHands: [] };
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

  // Role editor: broad role + (conditional) detailed sub-role. Role stays purely
  // role (R6 cleanup) — the fine bowling-style sub-picker that used to appear here
  // when the broad role was "Bowler" is gone; profile.bowlingType is now set ONLY
  // via the standalone "Bowling style" condition (bowlingSel below).
  editorHosts.role.innerHTML = `
    <div class="profile-role">
      <div data-role="prof-roleGroup"></div>
      <div data-role="prof-roleSub" hidden></div>
    </div>`;
  const roleGroupHost = editorHosts.role.querySelector('[data-role="prof-roleGroup"]');
  const roleSubHost = editorHosts.role.querySelector('[data-role="prof-roleSub"]');
  editorHosts.hand.innerHTML = `<div data-role="prof-hand"></div>`;
  const handHost = editorHosts.hand.querySelector('[data-role="prof-hand"]');
  editorHosts.bowling.innerHTML = `<div data-role="prof-bowling"></div>`;
  const bowlingHost = editorHosts.bowling.querySelector('[data-role="prof-bowling"]');
  editorHosts.bowlingHand.innerHTML = `<div data-role="prof-bowlingHand"></div>`;
  const bowlingHandHost = editorHosts.bowlingHand.querySelector('[data-role="prof-bowlingHand"]');

  const roleGroupSel = mountSearchSelect(roleGroupHost, {
    searchable: false,
    portal: true,
    ariaLabel: "Playing Role",
    placeholder: "Any Role",
    allowEmptyLabel: "Any Role",
    onChange: (val) => {
      setProfile({ roleGroup: val || null, roleSub: null });
      renderProfileEditors();
      onChange();
    },
  });
  wireSearchPickerEscape(roleGroupHost, roleGroupSel);
  const roleSubSel = mountSearchSelect(roleSubHost, {
    searchable: false,
    portal: true,
    ariaLabel: "Detailed Role",
    placeholder: "Any",
    allowEmptyLabel: "Any",
    onChange: (val) => {
      setProfile({ roleSub: val || null });
      onChange();
    },
  });
  wireSearchPickerEscape(roleSubHost, roleSubSel);
  const handSel = mountSearchSelect(handHost, {
    searchable: false,
    portal: true,
    ariaLabel: "Batting Hand",
    placeholder: "Any",
    allowEmptyLabel: "Any",
    onChange: (val) => {
      setProfile({ battingHand: val || null });
      onChange();
    },
  });
  wireSearchPickerEscape(handHost, handSel);
  const bowlingSel = mountSearchSelect(bowlingHost, {
    searchable: false,
    portal: true,
    ariaLabel: "Bowling Style",
    placeholder: "Any",
    allowEmptyLabel: "Any",
    onChange: (val) => {
      setProfile({ bowlingType: val || null });
      onChange();
    },
  });
  wireSearchPickerEscape(bowlingHost, bowlingSel);
  const bowlingHandSel = mountSearchSelect(bowlingHandHost, {
    searchable: false,
    portal: true,
    ariaLabel: "Bowling Hand",
    placeholder: "Any",
    allowEmptyLabel: "Any",
    onChange: (val) => {
      setProfile({ bowlingArm: val || null });
      onChange();
    },
  });
  wireSearchPickerEscape(bowlingHandHost, bowlingHandSel);

  // ── "Vs" matchup editor (R3.2; R3 harmonisation: raw <select> → shared panel) ──
  // Mirrors the results-toolbar's bonded Vs control — both edit state.matchupVs,
  // kept in sync purely through the shared store (a change here calls onChange →
  // main.js re-syncs the toolbar; a toolbar change re-syncs this via renderVsEditor(),
  // called from syncSingletonRows() on every store change). buildMatchupQuery is
  // untouched. Options depend on discipline (batting → pace/spin group + fine
  // bowling types; bowling → batting hand) and match the toolbar's set — the fine
  // bowling types come from the SAME matchup_batting distinct-values query, so any
  // value set on either side displays on the other. The TOOLBAR's own Vs control
  // (src/table.js) stays a native <select> (owner ruling — keep the toolbar tight);
  // only this drawer copy (and the player pop-up's) move to the shared searchable-
  // panel component, the same migration the five profile pickers already did.
  // ── Composite matchupVs helpers (decision 81A + 83 Fork 2) ───────────────────
  // state.matchupVs is a COMBINABLE map — several opponent axes AND-ed ({group|type|
  // hand|potm: value}). These writers normalise the current value (via matchupVsAxes,
  // which accepts the legacy single object AND the map) into a plain {dim: value} map,
  // mutate ONE axis, and write the map back (null when empty). Each writer preserves
  // every OTHER axis, so the Matchup rows and the (migrated) toolbar Vs never clobber
  // one another. buildMatchupQuery reads the same matchupVsAxes, so numbers are sacred.
  // The STYLE dims for the current board (group/type on batting; hand on bowling) are
  // mutually exclusive with each other — the single vsSel picks exactly one.
  const STYLE_DIMS_BY_DISC = { batting: ["group", "type"], bowling: ["hand"] };
  const matchupVsMap = (s) => {
    const map = {};
    for (const ax of matchupVsAxes(s.matchupVs)) map[ax.dim] = ax.value;
    return map;
  };
  const writeMatchupVsMap = (map) => {
    const keys = Object.keys(map);
    store.set({ matchupVs: keys.length ? { ...map } : null });
  };
  // Set the ONE style/hand axis for the current board, dropping the others (they are
  // mutually exclusive) and preserving non-style axes (potm). value ""/null clears it.
  function setMatchupStyleAxis(dim, value) {
    const map = matchupVsMap(store.get());
    delete map.group;
    delete map.type;
    delete map.hand;
    if (value != null && value !== "") map[dim] = value;
    writeMatchupVsMap(map);
  }
  // Remove the named dims (preserving the rest) — the Matchup rows' clear/remove path.
  function removeMatchupDims(dims) {
    const map = matchupVsMap(store.get());
    for (const d of dims) delete map[d];
    writeMatchupVsMap(map);
  }
  // Set a single axis (preserving the rest) — used to turn ON the valueless potm axis.
  function setMatchupAxis(dim, value) {
    const map = matchupVsMap(store.get());
    if (value == null || value === "") delete map[dim];
    else map[dim] = value;
    writeMatchupVsMap(map);
  }
  // Is a STYLE/HAND axis set for the current board? (potm alone does NOT count — it has
  // its own row.) Drives the "vs" row's presence + inert cue.
  const matchupStyleAxisSet = (s) =>
    matchupVsAxes(s.matchupVs).some((ax) => (STYLE_DIMS_BY_DISC[s.discipline] || []).includes(ax.dim));
  const matchupPotmAxisSet = (s) => matchupVsAxes(s.matchupVs).some((ax) => ax.dim === "potm");

  const vsSel = mountSearchSelect(editorHosts.vs, {
    searchable: false,
    portal: true,
    ariaLabel: "Matchup opponent",
    // "Anyone" cue for the no-value state (matches the leaf's title-case naming).
    placeholder: "Anyone",
    allowEmptyLabel: "Anyone",
    onChange: (val) => {
      // The inline style/hand menu edits ONLY this board's style axis of the composite
      // matchupVs, preserving any potm axis. "" (Anyone) clears just the style axis.
      if (!val) {
        setMatchupStyleAxis(null, null);
      } else {
        const i = val.indexOf(":");
        setMatchupStyleAxis(val.slice(0, i), val.slice(i + 1));
      }
      onChange();
    },
  });
  wireSearchPickerEscape(editorHosts.vs, vsSel);
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
  function renderVsEditor() {
    const s = store.get();
    // Fetch the fine bowling types on demand for the batting view; re-render
    // once they arrive so a fine "type:…" value shows selected rather than
    // falling back to "Everyone".
    if (s.discipline === "batting" && !vsBowlingTypes) {
      loadVsBowlingTypes().then(() => renderVsEditor());
    }
    // Reflect ONLY the style/hand axis of the composite matchupVs (potm is a separate
    // row) — via matchupVsAxes, never a direct `.dim`/`.value` read.
    const styleDims = STYLE_DIMS_BY_DISC[s.discipline] || [];
    const styleAxis = matchupVsAxes(s.matchupVs).find((ax) => styleDims.includes(ax.dim));
    const current = styleAxis ? `${styleAxis.dim}:${styleAxis.value}` : null;
    // Same option SET and ORDER as the old <select> — "Anyone" (via allowEmptyLabel,
    // above) leads, then Pace/Spin, then the fine bowling types for batting; just the
    // two hand buckets for bowling. Group labels reproduce the old <optgroup>s.
    let opts;
    if (s.discipline === "batting") {
      opts = [
        { value: "group:Pace", label: "Pace", group: "Pace / spin" },
        { value: "group:Spin", label: "Spin", group: "Pace / spin" },
        ...(vsBowlingTypes || []).map((t) => ({ value: `type:${t}`, label: matchupBucketLabel(t), group: "Bowling type" })),
      ];
    } else {
      opts = [
        // R4-C naming (locked): "Right-hand batter" / "Left-hand batter" — never
        // "Right-handers"/"Left-handers". These describe the opponent BATTER's hand
        // (this branch is the bowling-discipline Vs editor).
        { value: "hand:Right-hand bat", label: "Right-Hand Batter" },
        { value: "hand:Left-hand bat", label: "Left-Hand Batter" },
      ];
    }
    vsSel.setOptions(opts);
    vsSel.setValue(current);
  }

  // ── Matchup lane section (decision 83 Fork 2) ────────────────────────────────
  // The Matchup <section> holds one condition row per added axis (re-parented in by
  // syncMatchupRows). This only toggles the SECTION's visibility: show it iff ≥1 Matchup
  // row is present, hide it otherwise (an empty section would leave a stray title/gap —
  // mirrors how the numeric block hides while empty). The "+ Add ▸ Matchup" dropdown
  // itself lives in the group card's add-row (renderAddRow), so the entry point stays
  // available even while this section is hidden. No query path (numbers sacred).
  function renderMatchupSection() {
    if (!matchupLaneEl) return;
    const s = store.get();
    const hasRow = SINGLETON_TYPES.some(
      (t) => singletonLane(t.key, s.discipline) === "matchup" && rowEls[t.key] && !rowEls[t.key].hidden
    );
    matchupLaneEl.hidden = !hasRow;
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
    handSel.setOptions(toOptions(profileOptions.battingHands));
    handSel.setValue(p.battingHand);
    // Cutover S1: the Bowling Style filter options display title-case (value stays the
    // RAW profiles.bowling_type — setProfile/setValue below round-trip the raw string,
    // so buildQuery's `bowling_type = '…'` literal is unchanged). Bowling-scoped only —
    // the shared `toOptions` (role/hand) is untouched.
    bowlingSel.setOptions((profileOptions.bowlingTypes || []).map((v) => ({ value: v, label: bowlingStyleDisplayLabel(v) })));
    bowlingSel.setValue(p.bowlingType);
    bowlingHandSel.setOptions(toOptions(profileOptions.bowlingHands));
    bowlingHandSel.setValue(p.bowlingArm);
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
            `  (SELECT list(DISTINCT batting_style) FROM profiles WHERE batting_style IS NOT NULL) AS batting_styles,`,
            `  (SELECT list(DISTINCT bowling_arm) FROM profiles WHERE bowling_arm IS NOT NULL) AS bowling_arms`,
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
        bowlingHands: orderBy(optRow.bowling_arms ?? [], BOWLING_HAND_ORDER),
      };
      profileOptionsErrored = false;
    } catch (e) {
      if (token !== profileOptionsLoadToken) return;
      profileOptionsErrored = true;
    }
    renderProfileEditors();
  }

  // ── Editors for Batting position / Team / Opposition / Event / Venue ─────────
  // "Batting position" (state.positions) mounts in its own `strikerpos` row and,
  // per the position rework (2026-08-14), shows in PLAIN batting as well as any
  // matchup (never in plain bowling — no batting_position column there).
  const battingPositionController = mountBattingPosition(editorHosts.strikerpos, store, onChange, { embedded: true });
  // The five CASCADING pickers each know which of their picked values the rest of
  // the filters have made impossible, and tell us when their option list reloads
  // (onOptionsLoaded) so the empty-result notice below can be re-derived — a load
  // changes nothing in state, so nothing else would prompt a refresh.
  const onCascadeOptionsLoaded = () => syncEmptyNotice();
  const teamController = mountTeam(editorHosts.team, store, onChange, { onOptionsLoaded: onCascadeOptionsLoaded });
  const oppositionController = mountOpposition(editorHosts.opposition, store, onChange, { embedded: true, onOptionsLoaded: onCascadeOptionsLoaded });
  const eventController = mountEvent(editorHosts.event, store, onChange, { onOptionsLoaded: onCascadeOptionsLoaded });
  const venueController = mountVenue(editorHosts.venue, store, onChange, { onOptionsLoaded: onCascadeOptionsLoaded });
  const cityController = mountCity(editorHosts.city, store, onChange, { onOptionsLoaded: onCascadeOptionsLoaded });
  const seasonController = mountSeason(editorHosts.season, store, onChange, { onOptionsLoaded: onCascadeOptionsLoaded });
  const fieldingPositionController = mountFieldingPosition(editorHosts.fld_pos, store, onChange, { embedded: true });
  // Match-context editors (Wave 6): each writes only its own state key.
  const resultController = mountResult(editorHosts.mc_result, store, onChange, { embedded: true });
  const tossResultController = mountTossResult(editorHosts.mc_toss_result, store, onChange, { embedded: true });
  const tossDecisionController = mountTossDecision(editorHosts.mc_toss_decision, store, onChange, { embedded: true });
  // PotM (Y/N) (Wave D — TASK B): a fixed Yes/No categorical singleton (state.potmYN).
  const potmYNController = mountPotmYN(editorHosts.potm_yn, store, onChange, { embedded: true });
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

  // ── Fielding board dim rows (3.2b2) ──────────────────────────────────────────
  // The full fielding dim set (every catalogue dim EXCEPT position — that stays on
  // fld_pos, byte-identical everywhere) as inline condition rows writing state.fielding.*.
  // Shown only on the Fielding board; its palette leaves live in the paletteGroups
  // `disc === "fielding"` branch (wired via the deps below). requestRerender re-renders
  // the singleton rows + numeric-group palettes (no query) after a reveal/remove or a
  // data-driven option list resolving, so the offered/disabled set settles.
  const fieldingDimHost = advancedHost.querySelector('[data-role="fielding-dim-rows"]');
  const fieldingDims = createFieldingDimsController({
    host: fieldingDimHost,
    store,
    onChange,
    requestRerender: () => { syncSingletonRows(); renderNumeric(store.get(), true); },
  });

  // ── "This will come back empty" notice (owner ruling) ──────────────────────
  // Since a dead-end pick is now KEPT and greyed rather than reset, a search can
  // legitimately return no rows. When one filter's ENTIRE selection is currently
  // impossible, that filter ALONE guarantees an empty result — a fact each picker
  // already has from its own option list, so this costs no extra query. Say so
  // plainly, name the control, and leave Search fully enabled: it informs, it
  // never blocks. Only these five report; the fixed-vocabulary pickers (Result,
  // Toss…, Innings Number) have no cross-filtered list and can't go dead this way.
  const cascadeControllers = [venueController, cityController, seasonController, eventController, teamController, oppositionController, stageController];
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
      // Batting hand is a batting-only concept in the batting↔bowling sense (decision
      // 54): a player's batting hand isn't their bowling arm, so the row never shows
      // while BOWLING is active, and the store clears profile.battingHand on every
      // discipline change. The FIELDING board (3.2b2) also offers it as a PROFILE filter
      // (the FIELDER's batting style narrows the fielder set via the fielder_id semi-join
      // — owner: include it), so presence is allowed on fielding too. Bowling stays
      // gated and the clear-on-change is untouched, so batting/bowling are byte-identical.
      case "hand": return (s.discipline === "batting" || s.discipline === "fielding") && Boolean(s.profile.battingHand);
      case "bowling": return Boolean(s.profile.bowlingType);
      // Bowling hand (owner #8): mirrors "bowling" — no discipline gate (a
      // player's bowling arm is meaningful whichever discipline you're viewing).
      case "bowlingHand": return Boolean(s.profile.bowlingArm);
      // The "vs" row is the STYLE/HAND axis only (present iff a group/type/hand axis is
      // set for this board); the potm axis has its OWN row (vs_potm), so it must NOT keep
      // the style row alive. matchupStyleAxisSet reads via matchupVsAxes (composite-safe).
      case "vs": return matchupStyleAxisSet(s);
      case "vs_potm": return matchupPotmAxisSet(s); // present iff the potm axis is set
      // "Batting position" (state.positions): present when it has a value.
      // isPresent additionally gates strikerpos on (plain batting OR matchup), so
      // it never shows in plain bowling and never merely because a Vs bucket was
      // picked with no position chosen.
      // Innings Number (Wave R2c): present when it has a value (both disciplines).
      case "inn_num":
        return (s.inningsNumber || []).length > 0;
      case "strikerpos":
        return (s.positions || []).length > 0;
      case "team": return (s.teams || []).length > 0;
      case "opposition": return (s.opposition || []).length > 0;
      case "event": return (s.event || []).length > 0;
      case "venue": return (s.venue || []).length > 0;
      case "city": return (s.city || []).length > 0;
      case "season": return (s.season || []).length > 0;
      // Fielding SLICE conditions: present when their list has a value.
      case "fld_pos": return Boolean(s.fielding && (s.fielding.positions || []).length > 0);
      // Match-context singletons (Wave 6): present when their value is set. Result
      // (FIX A) and Stage (polish item 3) are present once their condition is added
      // — each seeded to ["all"] (the "All" default) — so length > 0 covers both All
      // and specific picks; Result Condition (state.resultCondition) has no separate
      // row (it nests inside Result).
      case "mc_result": return (s.result || []).length > 0;
      case "mc_toss_result": return (s.tossResult || []).length > 0;
      case "mc_toss_decision": return (s.tossDecision || []).length > 0;
      // PotM (Y/N): present once its row is added (Yes/No picked, or either) — the
      // row stays visible while the user decides. Narrowing is a separate question
      // (potmYNFilterActive: exactly one picked); presence just governs the row.
      case "potm_yn": return (s.potmYN || []).length > 0;
      case "mc_stage": return (s.stage || []).length > 0;
      default: return false;
    }
  }

  const FIELDING_SLICE_KEYS = new Set(["fld_pos"]);

  // Fielding board (3.2b2): the ONLY singleton rows the fielding leaderboard query
  // actually honours — scope (Team/Opposition/Event/Venue), the four profile filters
  // (Role/Batting hand/Bowling style/Bowling hand, via the fielder_id semi-join), and
  // Dismissed batter's position (fld_pos). Every OTHER singleton is a batting/bowling/
  // matchup filter the fielding query IGNORES (top-level match-context / positions /
  // innings number / PotM / delivery window / opponent player / matchup Vs), so it is
  // hidden on the Fielding board — never a dishonest, silently-ignored row. The honest
  // fielding dims (Wicket type / Bowler style / Phase / …) are separate rows owned by
  // the fielding-dim controller, not the singleton machinery.
  const FIELDING_BOARD_SINGLETONS = new Set([
    "team", "opposition", "event", "venue", "role", "hand", "bowling", "bowlingHand", "fld_pos",
  ]);

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
      case "bowlingHand": return availability.isAvailable("profileBowlingArm", s);
      case "vs":
      // vs PotMs is CROSS-BOARD (the reconstructed vs_potm column exists on both matchup
      // views), so it rides the same per-board matchup-data gate as "vs": available iff
      // the board's matchup source exists (men today; women when their profiles land).
      case "vs_potm":
        return availability.isAvailable(s.discipline === "batting" ? "vsBowlingStyle" : "vsBattingHand", s);
      case "strikerpos":
        // Batting position (position rework 2026-08-14): plain batting always carries
        // batting_position (both genders) → available; in matchup it rides the matchup
        // source like "vs". Data-driven, no gender hardcode.
        return s.discipline === "batting" || availability.isAvailable("vsBattingHand", s);
      default: return true;
    }
  }

  // Re-render the singleton rows + numeric groups (the palette hosts) once an
  // availability probe resolves, so a scope's offered set settles. Hoisted so the
  // deps/availability wiring above can reference it.
  function availabilityOnReady() {
    syncSingletonRows();
    renderNumeric(store.get(), true);
    renderAddRow();
  }

  function isPresent(t, s) {
    // Fielding board (3.2b2): only the honoured singletons may surface there (see
    // FIELDING_BOARD_SINGLETONS) — everything else is a batting/bowling/matchup filter
    // the fielding query ignores, so its row never shows on the Fielding board. Skipped
    // entirely off the Fielding board, so batting/bowling presence is byte-identical.
    if (s.discipline === "fielding" && !FIELDING_BOARD_SINGLETONS.has(t.key)) return false;
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
    // "Batting position" (position rework 2026-08-14): shows in PLAIN batting and
    // any matchup, but NEVER in plain bowling (that view has no batting_position
    // column), even if a stale position value or a session-add lingers. Where it
    // does apply it follows the normal presence rule.
    if (t.key === "strikerpos" && !(matchupVsActive(s) || s.discipline === "batting")) return false;
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
      case "bowlingHand": setProfile({ bowlingArm: null }); break;
      // Removing the "vs" row clears ONLY the style/hand axis (group/type/hand) — a potm
      // axis (its own vs_potm row) survives. vs_potm clears only the potm axis.
      case "vs": removeMatchupDims(["group", "type", "hand"]); break;
      case "vs_potm": removeMatchupDims(["potm"]); break;
      case "inn_num": store.set({ inningsNumber: [] }); break;
      case "strikerpos": store.set({ positions: [] }); break;
      case "team": store.set({ teams: [] }); break;
      case "opposition": store.set({ opposition: [] }); break;
      case "event": store.set({ event: [], eventSeasons: {} }); break; // Wave 6 pt2: drop season narrowing too
      case "venue": store.set({ venue: [] }); break;
      case "city": store.set({ city: [] }); break;
      case "season": store.set({ season: [] }); break;
      case "fld_pos": store.set({ fielding: { ...(store.get().fielding || {}), positions: [] } }); break;
      // Removing Result also removes its nested Result Condition (FIX B).
      case "mc_result": store.set({ result: [], resultCondition: [] }); break;
      case "mc_toss_result": store.set({ tossResult: [] }); break;
      case "mc_toss_decision": store.set({ tossDecision: [] }); break;
      case "potm_yn": store.set({ potmYN: [] }); break;
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
    } else if (key === "vs_potm") {
      // "vs PotMs" is a VALUELESS row — adding it IS the filter. Turn ON the potm axis
      // of the composite matchupVs (preserving any style/hand axis already picked).
      setMatchupAxis("potm", "1");
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
    // Fielding board (3.2b2): the `disc === "fielding"` branch offers the fielding dim
    // rows through these — reveal a dim row, and gate its leaf on the (data-driven)
    // option list + present state. Inert on batting/bowling (that branch never runs).
    pickFieldingDim: (dimKey) => fieldingDims.reveal(dimKey),
    fieldingDimOfferable: (dimKey, s) => fieldingDims.offerable(dimKey, s),
    fieldingDimPresent: (dimKey, s) => fieldingDims.isPresent(dimKey, s),
  });

  // ── Palette component (portal + search + ▸ drill-down) — src/addPalette.js ────
  // The generic search-palette machinery (leak-free portal, list build,
  // search/highlight, ▸ drill-down, open/close, "only one open at a time") was
  // extracted to src/addPalette.js in Wave R3 so the player pop-up drawer can
  // mount the SAME component. Each leaf's run() closure still fires pickSingleton /
  // pickMetric here, so the palette — and every number it produces — is byte-
  // identical to the pre-extraction inline version (numbers sacred; no query path
  // lives in addPalette.js or paletteGroups.js).
  //
  // Chunk 5 · Phase 1 (two Player/Scope dropdowns, LAYOUT ONLY): the single
  // "+ Add condition" trigger per numeric group card is split into TWO lane
  // dropdowns — "Player Filters" and "Scope Filters" — mirroring the columns
  // section's dropdowns-in-a-row (columnsPicker.js). ONE createAddPalette instance
  // still backs BOTH (as columns' one instance backs its four discipline triggers),
  // so "only one open at a time" holds across both dropdowns and every group card.
  // `gi` is overloaded here — columns uses it as the "which dropdown" axis, but the
  // filter drawer needs it as the numeric GROUP index (pickMetric's target). So the
  // skeleton's data-gi ENCODES both: `encodedGi = groupIndex*4 + laneIndex`
  // (0 = player, 1 = scope, 2 = matchup — decision 83 Fork 2's third dropdown).
  // buildGroups decodes and hands buildPaletteGroups the REAL groupIndex (so pickMetric
  // targets the right group) plus the resolved lane. Only group 0 exists on the
  // leaderboard, so groupIndex is always 0 in practice; the *4 base keeps room for the
  // three lanes. `palette.closeCurrent()` closes whichever is open before a rebuild (a
  // portaled-open panel would otherwise orphan on <body>).
  const LANE_BY_INDEX = ["player", "scope", "matchup"];
  const palette = createAddPalette({
    buildGroups: (encodedGi) => {
      const groupIndex = encodedGi >> 2;
      const lane = LANE_BY_INDEX[encodedGi & 3];
      return buildPaletteGroups(store.get(), groupIndex, { surface: "leaderboard", lane });
    },
  });

  // ── Insertion-order rendering (Way A review fix, decision 83, 2026-08-29) ─────
  // The group's conditions render as ONE continuous list in the order the user ADDED
  // them — NOT split into a Player block then a Scope block (owner: "if I choose a
  // player scope then a filter scope then a player scope, it needs to show in that
  // order without gaps"). Each SLOT — a singleton row, the numeric metric block, or the
  // fielding-dim block — is stamped with an incrementing sequence the first time it
  // becomes present; losing presence forgets it, so re-adding a condition appends it at
  // the END. Display-only: this reorders DOM nodes and toggles `hidden`; it never touches
  // state, the store, or any query (numbers sacred). The sequence map lives for the
  // drawer's lifetime (mounted once), so order is stable across popup reopens; pre-existing
  // (already-valued) conditions seed in SINGLETON_TYPES order (the documented applied-row
  // order) on the first sync, since state records no add-order and we may not add one.
  const NUMERIC_SLOT = "__numeric__";
  const FIELDING_SLOT = "__fielding__";
  const activationSeq = new Map();
  let activationCounter = 0;
  function noteActivation(slotKey, present) {
    if (present) {
      if (!activationSeq.has(slotKey)) activationSeq.set(slotKey, activationCounter++);
    } else {
      activationSeq.delete(slotKey);
    }
  }

  // Re-append every PRESENT slot into the single list in activation order, and hide the
  // numeric / fielding blocks while they hold no condition (a visible-but-empty flex child
  // would otherwise add a stray gap; the synthetic empty group-0 card does NOT count as a
  // numeric condition). Singleton rows' own hidden state is set by syncSingletonRows /
  // fieldingDims.sync just before this runs — this only READS it. Numeric-block presence is
  // the numeric slot's insertion anchor (owner Q1 keeps the numeric block's OWN internal
  // Match-all/any toggle). Skips the DOM write when the present-child order already matches.
  function syncCondOrder() {
    if (!condRowsListEl) return;
    const s = store.get();
    const numericPresent = realGroups(s).some((g) => (g.conds || []).length > 0);
    numericEl.hidden = !numericPresent;
    const fieldingPresent = Boolean(fieldingDimRowsEl && fieldingDimRowsEl.querySelector('[data-fdim]:not([hidden])'));
    if (fieldingDimRowsEl) fieldingDimRowsEl.hidden = !fieldingPresent;

    const slots = [];
    for (const t of SINGLETON_TYPES) {
      // Matchup-lane rows (by CURRENT discipline — strikerpos is Player on batting but
      // Matchup on bowling) are placed by syncMatchupRows, not here.
      if (singletonLane(t.key, s.discipline) === "matchup") continue;
      const el = rowEls[t.key];
      const present = Boolean(el) && !el.hidden;
      noteActivation(t.key, present);
      if (present) slots.push([activationSeq.get(t.key), el]);
    }
    noteActivation(NUMERIC_SLOT, numericPresent);
    if (numericPresent) slots.push([activationSeq.get(NUMERIC_SLOT), numericEl]);
    noteActivation(FIELDING_SLOT, fieldingPresent);
    if (fieldingPresent) slots.push([activationSeq.get(FIELDING_SLOT), fieldingDimRowsEl]);

    slots.sort((a, b) => a[0] - b[0]);
    const desired = slots.map(([, el]) => el);
    const currentPresent = Array.from(condRowsListEl.children).filter((el) => !el.hidden);
    const same = currentPresent.length === desired.length && currentPresent.every((el, i) => el === desired[i]);
    if (!same) for (const el of desired) condRowsListEl.appendChild(el);
  }

  // ── Matchup lane rows (decision 83 Fork 2) ───────────────────────────────────
  // Re-parent the PRESENT Matchup-lane singleton rows (vs / vs_potm / vs_opp, + strikerpos
  // on the bowling board) into the Matchup section's own list, in activation order — the
  // exact syncCondOrder pattern, but targeting matchupRowsListEl. Because a DOM node has
  // one parent, appending a row here MOVES it out of the group card's list (and back, when
  // its lane flips on a discipline switch — syncCondOrder re-appends it there). The rows'
  // editors ride along (they are children), so nothing is re-mounted. Display-only.
  function syncMatchupRows() {
    if (!matchupRowsListEl) return;
    const s = store.get();
    const rows = [];
    for (const t of SINGLETON_TYPES) {
      if (singletonLane(t.key, s.discipline) !== "matchup") continue;
      const el = rowEls[t.key];
      const present = Boolean(el) && !el.hidden;
      noteActivation(t.key, present);
      if (present) rows.push([activationSeq.get(t.key), el]);
    }
    rows.sort((a, b) => a[0] - b[0]);
    const desired = rows.map(([, el]) => el);
    const currentPresent = Array.from(matchupRowsListEl.children).filter((el) => !el.hidden);
    const same = currentPresent.length === desired.length && currentPresent.every((el, i) => el === desired[i]);
    if (!same) for (const el of desired) matchupRowsListEl.appendChild(el);
  }

  // ── Singleton rows: show/hide + editor sync ─────────────────────────────────
  // Is a singleton row actually NARROWING the result right now? (vs merely present.)
  // Mirrors the pills' `inert` test: the imported *FilterActive predicates for the
  // sentinel-bearing filters (Result/Stage/PotM… default to a no-narrowing "All"/both),
  // and hasValue for the rest (team/city/season/profile/window pieces have no inert
  // sentinel — any value narrows). Drives the dim-empty-rows cue only; no query effect.
  function isSingletonActive(key, s) {
    switch (key) {
      case "vs_opp": return opponentPlayerActive(s);
      // "vs" is narrowing iff a style/hand axis is actually picked (the menu off "Anyone");
      // vs_potm is narrowing whenever present (adding it sets the potm axis).
      case "vs": return matchupStyleAxisSet(s);
      case "vs_potm": return matchupPotmAxisSet(s);
      case "inn_num": return inningsNumberFilterActive(s);
      case "strikerpos": return positionsFilterActive(s);
      case "opposition": return oppositionFilterActive(s);
      case "event": return eventFilterActive(s);
      case "venue": return venueFilterActive(s);
      case "fld_pos": return fieldingPositionActive(s);
      case "mc_result": return resultFilterActive(s);
      case "mc_toss_result": return tossResultFilterActive(s);
      case "mc_toss_decision": return tossDecisionFilterActive(s);
      case "potm_yn": return potmYNFilterActive(s);
      case "mc_stage": return stageFilterActive(s);
      default: return hasValue(key, s);
    }
  }

  function syncSingletonRows() {
    const s = store.get();
    for (const t of SINGLETON_TYPES) {
      // "vs" is now a normal presence-driven condition row (decision 83 Fork 2 — the
      // Matchup lane holds condition rows, not an always-visible panel), so it is no
      // longer skipped here; its presence follows isPresent like every other row.
      const present = isPresent(t, s);
      rowEls[t.key].hidden = !present;
      // Polish (Way A): dim an added-but-inert row — one that is showing yet not
      // actually narrowing the result (an unpicked Opposition, a Result left on "All",
      // a PotM Y/N with neither/both ticked). Display-only opacity cue; the query is
      // untouched. isSingletonActive mirrors the pills' own "inert" test.
      rowEls[t.key].classList.toggle("cond-row--inert", present && !isSingletonActive(t.key, s));
    }
    // "Batting position" is ONE control with a DISCIPLINE-dependent name (decision 81B,
    // owner 2026-08-27): on the batting board it is the subject's OWN position →
    // "Batting position"; on the bowling board the SAME control filters the OPPONENT
    // batter's position → "vs Opponent Batting Position" (a matchup axis). Display-only
    // relabel of the applied row's type label — the filter (state.positions →
    // batting_position IN) is byte-identical on both boards.
    if (typeLabelEls.strikerpos) {
      typeLabelEls.strikerpos.textContent = battingPositionFilterLabel(s.discipline);
    }
    // The "vs" row's label swaps by board too: batting = "vs Bowling Style" (the bowlers
    // faced), bowling = "vs Batting Hand" (the batters bowled to). Display-only.
    if (typeLabelEls.vs) {
      typeLabelEls.vs.textContent = s.discipline === "bowling" ? "vs Batting Hand" : "vs Bowling Style";
    }

    renderVsEditor();
    battingPositionController.sync();
    teamController.sync();
    oppositionController.sync();
    eventController.sync();
    venueController.sync();
    cityController.sync();
    seasonController.sync();
    fieldingPositionController.sync();
    resultController.sync();
    tossResultController.sync();
    tossDecisionController.sync();
    potmYNController.sync();
    inningsNumberController.sync();
    stageController.sync();
    winPhaseController.sync();
    winOversController.sync();
    winBallsController.sync();
    winPlayerController.sync();
    opponentController.sync();
    fieldingDims.sync();
    renderProfileEditors();
    // Re-order the single condition list by activation sequence (Way A review fix) —
    // runs after every row's hidden state (incl. fieldingDims.sync above) is settled.
    // syncCondOrder places the Player/Scope rows; syncMatchupRows re-parents the present
    // Matchup rows into their own section; renderMatchupSection toggles that section's
    // visibility. Order matters: the row hidden-states above must be settled first.
    syncCondOrder();
    syncMatchupRows();
    renderMatchupSection();
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
    // Polish (Way A): dim a numeric row with no value yet (an "empty" condition),
    // UNLESS it is already flagged with its red validation error (error emphasis wins).
    // Kept live by the value-input handler in wireNumeric so a filled row un-dims
    // without a rebuild. Display-only.
    const isInert = conditionHasError(cond) && !hasError;
    // Best Bowling (Wave A2 item 2): a COMPOUND "≥ [W] wickets for ≤ [R] runs"
    // condition — two labelled boxes (W→v1, R→v2) with NO operator select (the
    // comparison is implicit: at least W wickets conceding at most R runs in a
    // single innings). Every other metric keeps the operator + value layout.
    const isFigures = isBowlingFiguresCondition(cond);
    // Parametric threshold metrics (Innings Score / Wicket Hauls). These carry a
    // `paramTemplate` + `param` descriptor (metrics.js). R2 (2026-08-09): they are
    // now a NORMAL numeric-condition editor whose operator + value apply to the
    // PER-INNINGS score (runs / wickets) — the filter is an existence gate ("has ≥1
    // innings meeting score [op] N", compiled by metrics.paramExistenceHaving from
    // cond.operator + cond.v1 [+ cond.v2 for between]). The old score-threshold box
    // (cond.n) and the count-operator/value are GONE. The only render differences
    // from a plain numeric row: the label drops the "≥ N" token, and the operator
    // select carries a blank "Choose…" option so nothing is pre-selected (owner:
    // no prefills — the row commits only once an operator AND a value are set).
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
      // R4-C: step derived from the metric's own format (metricInputStep) — counts
      // stay integer, rates/averages/% get up to 2dp. Input precision only; the
      // HAVING value itself is untouched.
      const step = metricInputStep(rowMetric);
      valueFields = `<input type="number" step="${step}" class="input cond-row__value-input" data-role="v1" value="${escAttr(cond.v1)}" placeholder="min" />
           <span class="cond-row__and">and</span>
           <input type="number" step="${step}" class="input cond-row__value-input" data-role="v2" value="${escAttr(cond.v2)}" placeholder="max" />`;
    } else {
      const step = metricInputStep(rowMetric);
      valueFields = `<input type="number" step="${step}" class="input cond-row__value-input" data-role="v1" value="${escAttr(cond.v1)}" placeholder="value" />`;
    }
    // Param rows prepend a blank "Choose…" option (selected while the operator is
    // unset) so no operator is pre-selected — the row is inert until one is chosen.
    const operatorSelect = isFigures
      ? ""
      : `<select class="select" data-role="operator">
              ${paramMeta ? `<option value=""${cond.operator ? "" : " selected"}>Choose…</option>` : ""}
              ${OPERATORS.map((o) => `<option value="${o.key}" ${cond.operator === o.key ? "selected" : ""}>${o.label}</option>`).join("")}
            </select>`;
    // Param metrics: drop the "≥ N" token from the label ("Innings Score ≥ N" →
    // "Innings Score") — the operator is chosen now, so the fixed "≥ N" caption is
    // gone. Everything after is the plain operator + value layout.
    const rawLabel = metricLabel(cond.metricKey, ns, formats);
    const typeLabel = paramMeta ? rawLabel.replace(/\s*≥\s*N\s*$/, "") : rawLabel;
    return `
      <div class="cond-row cond-row--metric ${hasError ? "cond-row--error" : ""}${isInert ? " cond-row--inert" : ""}" data-gi="${gi}" data-ci="${ci}">
        <div class="cond-row__line">
          <div class="cond-row__main">
            <span class="cond-row__type">${escHtml(typeLabel)}</span>
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
    // Way A (decision 83): both "+ Add condition" dropdowns now live in the group
    // card's top add-row (renderAddRow), side-by-side — the Player Filters trigger no
    // longer sits inside each numeric group card. Only group 0 ever exists ("+ Add
    // group" was killed, decision 76.6), so the top Player trigger (encodedGi 0)
    // targets the one group directly. The card keeps its per-group Match-all/any
    // toggle (setGroupOp — the numeric block's OWN operator, distinct from the single
    // group operator above) when it has ≥2 conditions, plus its rows.
    return `
      <div class="cond-group${multi ? " is-multi" : ""}" data-gi="${gi}">
        ${head}
        <div class="cond-group__rows">${rows}</div>
      </div>`;
  }

  // Build ONE lane add-dropdown trigger (the columns-section trigger look).
  // `encodedGi` = groupIndex*4 + laneIndex (0 = player, 1 = scope, 2 = matchup) — the
  // same encoding the shared palette's buildGroups decodes. The three triggers are
  // rendered by renderAddRow into the group card's top add-row. Player/Scope are never
  // empty in practice (Player always has stat metrics, Scope always has Match Details);
  // Matchup CAN be empty (women / flag-off with no matchup data) — renderAddRow hides it
  // then rather than showing a disabled trigger.
  function laneTriggerHTML(lane, encodedGi, s) {
    const gi = encodedGi >> 2;
    const label = lane === "player" ? "Player Filters" : lane === "scope" ? "Scope Filters" : "Matchup";
    const empty = buildPaletteGroups(s, gi, { surface: "leaderboard", lane }).length === 0;
    return paletteSkeletonHTML(encodedGi, {
      ctlClass: "addctl cols-dd-ctl",
      toggleClass: "cols-dd-trigger",
      toggleAttrs: empty ? " disabled" : "",
      toggleAriaLabel: `Add a ${label} condition`,
      toggleInner: `<span class="cols-dd-name">${escHtml(label)}</span><span class="cols-dd-caret" aria-hidden="true">▾</span>`,
      searchPlaceholder: "Search filters&hellip;",
      searchAriaLabel: "Search filters",
      emptyText: "No matching filter.",
    });
  }

  // Render + mount BOTH "+ Add condition" dropdowns into the group card's top add-row
  // (mounted here — the hosts live in the stable skeleton, outside numericEl, so
  // renderNumeric never wipes them; the shared palette re-reads state on every open, so
  // their offered/disabled leaves stay fresh without a rebuild). Player Filters =
  // encodedGi 0 (group 0 — the only group; "+ Add group" was killed, 76.6); Scope
  // Filters = encodedGi 1 (groupIndex irrelevant — all scope filters are singletons,
  // added via the gi-agnostic pickSingleton). The two hosts ARE the `.cond-lane-bar`
  // wrappers, laid out side-by-side by the add-row (a third dropdown — Matchup, Task 3
  // — drops into the same row without rework).
  function renderAddRow() {
    palette.closeCurrent();
    const s = store.get();
    const playerHost = advancedHost.querySelector('[data-role="player-add"]');
    const scopeHost = advancedHost.querySelector('[data-role="scope-add"]');
    const matchupHost = advancedHost.querySelector('[data-role="matchup-add"]');
    if (playerHost) playerHost.innerHTML = laneTriggerHTML("player", 0, s);
    if (scopeHost) scopeHost.innerHTML = laneTriggerHTML("scope", 1, s);
    // Matchup (decision 83 Fork 2): the THIRD dropdown (encodedGi 2). HIDDEN when it has
    // no offerings (women / flag-off with no matchup data) — unlike Player/Scope which
    // always offer something, an empty Matchup dropdown reads as clutter, so we render no
    // trigger at all there rather than a disabled one.
    if (matchupHost) {
      const matchupEmpty = buildPaletteGroups(s, 0, { surface: "leaderboard", lane: "matchup" }).length === 0;
      matchupHost.innerHTML = matchupEmpty ? "" : laneTriggerHTML("matchup", 2, s);
    }
    advancedHost
      .querySelectorAll('[data-role="add-row"] [data-role="add-palette"]')
      .forEach((el) => palette.mountAddPalette(el));
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
    // Close any open palette before wiping the cards: a portaled-open panel would
    // otherwise be orphaned on <body> when its host addctl is replaced.
    palette.closeCurrent();
    numericEl.innerHTML = cards;
    wireNumeric();
    // Place the numeric block as ONE ordered slot (and hide it while it holds no real
    // condition) — pickMetric reaches here WITHOUT syncSingletonRows, so re-order here too.
    syncCondOrder();
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

      // v1 / v2 (values): edit cond[role]. (R2 removed the param "≥ N" box, so the
      // former data-role="n" handler is gone — parametric rows now use v1/v2 like
      // any numeric condition, with the operator applied to the per-innings score.)
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
          // Live-update the dim-empty cue in step with the value (same no-rebuild path).
          rowEl.classList.toggle("cond-row--inert", conditionHasError(cond) && !showErrors);
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
    fieldingDims.resetSession(); // same for the fielding board's dim rows
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
    syncGroupOpToggle();
    syncSingletonRows();
    renderNumeric(s);
    renderAddRow();
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
    // Fielding board (3.2b2): count ONLY the filters the fielding leaderboard query
    // actually narrows by — scope (Team/Opposition/Event/Venue), profile (role/hand/
    // bowling/bowlingArm via the fielder_id semi-join), the fielding dims (controller
    // rows + fld_pos position) and the count-threshold conditions (state.advanced). The
    // batting/bowling-only filters (top-level match-context / positions / innings / PotM /
    // delivery window / opponent player) are IGNORED by the fielding query, so a value
    // lingering from a prior batting/bowling scope must not inflate the fielding badge
    // (honest count, SPEC §8.4). Kept in its own early return so the batting/bowling
    // count below is byte-identical.
    if (s.discipline === "fielding") {
      let n = 0;
      if ((s.teams || []).length > 0) n++;
      const p = s.profile;
      if (p.roleGroup) n++;
      if (p.roleSub) n++;
      if (p.battingHand) n++;
      if (p.bowlingType) n++;
      if (p.bowlingArm) n++;
      if (oppositionFilterActive(s)) n++;
      if (eventFilterActive(s)) n++;
      if (venueFilterActive(s)) n++;
      if (fieldingPositionActive(s)) n++; // fld_pos position
      n += fieldingDims.activeCount(s); // the other fielding dims (Wicket type / Phase / …)
      n += activeConditionCount(s.advanced); // count-threshold tallies
      return n;
    }
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
      if (p.bowlingArm) n++;
    }
    if (positionsFilterActive(s)) n++;
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
    // PotM (Y/N) (Wave D — TASK B): counts only when narrowing (exactly one of
    // Yes/No — potmYNFilterActive); both/neither is a no-op sentinel like Result "All".
    if (potmYNFilterActive(s)) n++;
    if (inningsNumberFilterActive(s)) n++;
    if (stageFilterActive(s)) n++;
    if (resultConditionFilterActive(s)) n++;
    // Fielding SLICE conditions — plain mode only (inert under a matchup Vs).
    if (!matchupVsActive(s)) {
      if (fieldingPositionActive(s)) n++;
    }
    n += activeConditionCount(s.advanced);
    return n;
  }

  loadProfileOptions();
  sync();

  return { onShow, onHide, sync, activeCount, validate };
}
