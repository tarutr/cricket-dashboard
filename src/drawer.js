// src/drawer.js
//
// The "Player" + "Advanced Filters" content of the Filters popup (F1a — this
// used to be a right-side "All filters" drawer; the shell is gone and the
// content now renders straight into the popup's section bodies). Renders into
// two hosts passed by main.js:
//   Player host (compact block — F1b, no inner "Player profile" sub-header):
//     1. Team — a dual control: a mode dropdown ("Current team" | "Historic
//        team") + one team picker. Current = today's team filter (state.teams);
//        Historic = the old "Has ever played for (career)" filter (profile.teams,
//        absorbed here from Advanced). Exactly one is active at a time.
//     2. Profile grid — Role, Batting hand, R. Pos. (regular batting position —
//        see src/drawerInnings.js), Bowling style, in a tight aligned grid. In
//        matchup mode the R. Pos. slot is replaced by the striker/own
//        batting-position filter (state.positions), which self-hides in plain mode.
//   Advanced host:
//     3. One unified condition builder (src/advanced.js). "Against opposition"
//        is a condition TYPE inside it (still reads/writes state.opposition);
//        numeric stat-conditions write state.advanced. No inner sub-headers.
// The popup owns its own open/close/×/backdrop/Escape (main.js); this module
// exposes onShow()/onHide() hooks (called when the popup opens/closes),
// sync(), activeCount() (for the count badge), and validate() (the popup's
// "Search" button calls it before running the query).
//
// R. Pos. (decision 46) filters to players whose MOST COMMON batting position
// within scope is in the selection; the modal-position semi-join lives in
// filters.js's buildScopeClauses (state.regularPositions). It is innings-derived
// (not the men-only profile sheet), so it stays live on the Women view — where
// the profile-sheet dropdowns (Role/Batting hand/Bowling style) and the
// Historic-team mode are removed entirely (men-only, decision 21).
//
// This module renders/wires the DOM and calls store.set(...); it queries the
// database only for the team option-list lookup below (the opposition lookup
// lives in drawerInnings.js). It never queries for anything else — table.js
// and graph/*.js own re-querying on state change.

import { positionsFilterActive, regularPositionsFilterActive, oppositionFilterActive } from "./state.js";
import { query } from "./db.js";
import { buildScopeClauses, wirePortalDropdown } from "./filters.js";
import { mountAdvanced, activeConditionCount } from "./advanced.js";
import { mountBattingPosition, mountRegularPositions } from "./drawerInnings.js";
import { escHtml, escAttr } from "./html.js";

// Display order for the profile-filter option lists. Options are always
// intersected with the values actually present in player_profiles (so no dead
// options); anything present but unlisted here is appended alphabetically.
const ROLE_GROUP_ORDER = ["Batter", "Allrounder", "Bowler"];
const ROLE_SUB_ORDER = ["Opening", "Top-order", "Middle-order", "Wicketkeeper", "Batting allrounder", "Bowling allrounder"];
const BATTING_HAND_ORDER = ["Right-hand bat", "Left-hand bat"];
const BOWLING_TYPE_ORDER = [
  "Off-spin", "Leg-spin", "Slow left-arm orthodox", "Left-arm wrist-spin",
  "Slow-medium", "Medium", "Medium-fast", "Fast-medium", "Fast",
];

/** Sort `present` by a preferred order, appending unlisted values alphabetically. */
function orderBy(present, order) {
  const set = new Set(present);
  const ranked = order.filter((v) => set.has(v));
  const rest = present.filter((v) => !order.includes(v)).sort();
  return [...ranked, ...rest];
}

/**
 * Query DISTINCT teams present under the current gender+format+date+team_type
 * scope (excluding the team filter itself, and excluding search — that
 * doesn't affect which teams exist). batting_team for batting, bowling_team
 * for bowling.
 */
async function fetchTeamOptions(state) {
  const view = state.discipline === "batting" ? "batting" : "bowling";
  const teamCol = state.discipline === "batting" ? "batting_team" : "bowling_team";
  const idCol = state.discipline === "batting" ? "batter_id" : "bowler_id";
  const clauses = buildScopeClauses(state, { includeTeams: false, idColumn: idCol });
  const where = clauses.length ? clauses.join(" AND ") : "TRUE";
  const sql = `SELECT DISTINCT ${teamCol} AS team FROM ${view} WHERE ${where} AND ${teamCol} IS NOT NULL ORDER BY team`;
  const { rows } = await query(sql);
  return rows.map((r) => r.team);
}

/**
 * Render the Filters popup's "Player" (Team + Player profile) and "Advanced
 * Filters" content into the two hosts main.js passes (`{ playerHost,
 * advancedHost }` — both live inside the popup panel). Calls `onChange()` after
 * any state mutation so main.js can update the pills/subtitle/badge (it no
 * longer blanks the table). The popup owns open/close; this module exposes
 * onShow()/onHide() (open/close hooks), sync(), activeCount(), and validate().
 * Returns `{ onShow, onHide, sync, activeCount, validate }`.
 */
export function mountFilterDrawer({ playerHost, advancedHost }, store, { onChange }) {
  // Compact Player section (F1b — fixes player_profile.png): Team dual-control
  // on top, then Role / Batting hand / R. Pos. / Bowling style in a tight,
  // aligned grid (no control stranded beside dead space). The old inner
  // "Player profile" sub-header is gone — the collapsible section is already
  // titled "Player"; one "Team" sub-label remains.
  playerHost.innerHTML = `
    <div class="player-filters">
      <div class="player-filters__team">
        <span class="filter-label">Team</span>
        <div class="player-filters__team-row">
          <div class="filter-group filter-group--teammode" data-role="teammode-group">
            <select class="select" data-role="team-mode" aria-label="Team mode">
              <option value="current">Current team</option>
              <option value="historic">Historic team</option>
            </select>
          </div>

          <div class="filter-group filter-group--team" data-role="team-current-group">
            <div class="team-dropdown" data-role="team-dropdown">
              <button type="button" class="team-dropdown__toggle" data-role="team-toggle" aria-haspopup="true" aria-expanded="false">
                All teams
              </button>
              <div class="team-dropdown__panel" data-role="team-panel" hidden>
                <input type="text" class="team-dropdown__search" data-role="team-search" placeholder="Search teams…" />
                <div class="team-dropdown__list" data-role="team-list"></div>
                <div class="team-dropdown__actions">
                  <button type="button" class="link-btn" data-role="team-clear">Clear</button>
                </div>
              </div>
            </div>
          </div>

          <div class="filter-group filter-group--profteams" data-role="team-historic-group">
            <div class="team-dropdown" data-role="profteam-dropdown">
              <button type="button" class="team-dropdown__toggle" data-role="profteam-toggle" aria-haspopup="true" aria-expanded="false">
                Any team
              </button>
              <div class="team-dropdown__panel" data-role="profteam-panel" hidden>
                <input type="text" class="team-dropdown__search" data-role="profteam-search" placeholder="Search teams…" />
                <div class="team-dropdown__list" data-role="profteam-list"></div>
                <div class="team-dropdown__actions">
                  <button type="button" class="link-btn" data-role="profteam-clear">Clear</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="player-filters__profile">
        <p class="profile-note" data-role="profile-note" hidden>No bowling type data for Women available yet.</p>
        <p class="profile-note" data-role="profile-load-error" hidden>Couldn't load profile filter options — reopen the filters to retry.</p>

        <div class="profile-grid" data-role="profile-bar">
          <div class="filter-group filter-group--role" data-role="prof-role-group">
            <label class="filter-label" for="drawer-prof-roleGroup">Role</label>
            <div class="profile-role">
              <select class="select" id="drawer-prof-roleGroup" data-role="prof-roleGroup" aria-label="Playing role"></select>
              <select class="select" data-role="prof-roleSub" aria-label="Detailed role" hidden></select>
            </div>
          </div>

          <div class="filter-group filter-group--hand" data-role="prof-hand-group">
            <label class="filter-label" for="drawer-prof-battingHand">Batting hand</label>
            <select class="select" id="drawer-prof-battingHand" data-role="prof-battingHand" aria-label="Batting hand"></select>
          </div>

          <!-- R. Pos. (plain mode) and the matchup striker-position filter
               (matchup mode) share this slot; each self-hides in the other
               mode (see drawerInnings.js). display:contents on the hosts (CSS)
               promotes the inner control to a grid cell so a hidden one leaves
               no empty cell. -->
          <div data-role="rpos-host"></div>
          <div data-role="matchup-positions-host"></div>

          <div class="filter-group filter-group--bowling" data-role="prof-bowling-group">
            <label class="filter-label" for="drawer-prof-bowlingType">Bowling style</label>
            <select class="select" id="drawer-prof-bowlingType" data-role="prof-bowlingType" aria-label="Bowling style"></select>
          </div>
        </div>
      </div>
    </div>
  `;

  // Advanced Filters section (F1b): just the section title (from index.html) +
  // ONE unified condition builder (advanced.js). Opposition is now a condition
  // TYPE inside that builder (reads/writes state.opposition), so the old inner
  // "Advanced" sub-header, the standalone opposition picker, and the "Stat
  // conditions" sub-header are all gone.
  advancedHost.innerHTML = `<div data-role="advanced-host"></div>`;

  const els = {
    // Team + Player profile (playerHost)
    teamModeGroup: playerHost.querySelector('[data-role="teammode-group"]'),
    teamMode: playerHost.querySelector('[data-role="team-mode"]'),
    teamCurrentGroup: playerHost.querySelector('[data-role="team-current-group"]'),
    teamHistoricGroup: playerHost.querySelector('[data-role="team-historic-group"]'),
    teamToggle: playerHost.querySelector('[data-role="team-toggle"]'),
    teamPanel: playerHost.querySelector('[data-role="team-panel"]'),
    teamSearch: playerHost.querySelector('[data-role="team-search"]'),
    teamList: playerHost.querySelector('[data-role="team-list"]'),
    teamClear: playerHost.querySelector('[data-role="team-clear"]'),

    profileBar: playerHost.querySelector('[data-role="profile-bar"]'),
    profileNote: playerHost.querySelector('[data-role="profile-note"]'),
    profileLoadError: playerHost.querySelector('[data-role="profile-load-error"]'),
    roleFilterGroup: playerHost.querySelector('[data-role="prof-role-group"]'),
    handFilterGroup: playerHost.querySelector('[data-role="prof-hand-group"]'),
    bowlingFilterGroup: playerHost.querySelector('[data-role="prof-bowling-group"]'),
    roleGroup: playerHost.querySelector('[data-role="prof-roleGroup"]'),
    roleSub: playerHost.querySelector('[data-role="prof-roleSub"]'),
    battingHand: playerHost.querySelector('[data-role="prof-battingHand"]'),
    bowlingType: playerHost.querySelector('[data-role="prof-bowlingType"]'),
    profTeamToggle: playerHost.querySelector('[data-role="profteam-toggle"]'),
    profTeamPanel: playerHost.querySelector('[data-role="profteam-panel"]'),
    profTeamSearch: playerHost.querySelector('[data-role="profteam-search"]'),
    profTeamList: playerHost.querySelector('[data-role="profteam-list"]'),
    profTeamClear: playerHost.querySelector('[data-role="profteam-clear"]'),

    rposHost: playerHost.querySelector('[data-role="rpos-host"]'),
    matchupPositionsHost: playerHost.querySelector('[data-role="matchup-positions-host"]'),

    // Advanced Filters (advancedHost) — one unified condition builder
    advancedHost: advancedHost.querySelector('[data-role="advanced-host"]'),
  };

  // ── Team dropdown ────────────────────────────────────────────────────────
  let teamOptionsCache = []; // all available team names for the current scope
  let lastTeamScopeKey = null;
  let teamOptionsLoadToken = 0;
  let teamOptionsErrored = false;

  function teamScopeKeyFor(state) {
    return JSON.stringify([state.discipline, state.gender, state.formats, state.dateFrom, state.dateTo, state.teamType]);
  }

  function renderTeamList(filterText) {
    if (teamOptionsErrored) {
      els.teamList.innerHTML = `<p class="team-dropdown__empty">Couldn't load teams — reopen the drawer to retry.</p>`;
      return;
    }
    const q = (filterText || "").trim().toLowerCase();
    const selected = new Set(store.get().teams);
    const filtered = teamOptionsCache.filter((t) => t.toLowerCase().includes(q));
    els.teamList.innerHTML = filtered
      .map(
        (t) => `<label class="team-dropdown__item">
          <input type="checkbox" data-team="${escAttr(t)}" ${selected.has(t) ? "checked" : ""} />
          <span>${escHtml(t)}</span>
        </label>`
      )
      .join("") || `<p class="team-dropdown__empty">No teams match.</p>`;

    els.teamList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const current = new Set(store.get().teams);
        if (cb.checked) current.add(cb.dataset.team);
        else current.delete(cb.dataset.team);
        store.set({ teams: [...current] });
        updateTeamToggleLabel();
        onChange();
      });
    });
  }

  function updateTeamToggleLabel() {
    const teams = store.get().teams;
    els.teamToggle.textContent = teams.length === 0 ? "All teams" : teams.length === 1 ? teams[0] : `${teams.length} teams`;
  }

  async function refreshTeamOptions() {
    const state = store.get();
    const key = teamScopeKeyFor(state);
    if (key === lastTeamScopeKey) return;
    const token = ++teamOptionsLoadToken;
    try {
      const fetched = await fetchTeamOptions(state);
      if (token !== teamOptionsLoadToken) return; // a newer request superseded this one
      teamOptionsCache = fetched;
      teamOptionsErrored = false;
      lastTeamScopeKey = key;
    } catch (e) {
      if (token !== teamOptionsLoadToken) return;
      // Don't set lastTeamScopeKey on failure — it stays stale so the next
      // sync() (drawer reopen, or any other filter change) retries instead of
      // silently sticking with a dishonest "No teams match." empty state.
      teamOptionsErrored = true;
      renderTeamList(els.teamSearch.value);
      updateTeamToggleLabel();
      return;
    }
    const validSet = new Set(teamOptionsCache);
    const stillValid = state.teams.filter((t) => validSet.has(t));
    if (stillValid.length !== state.teams.length) {
      store.set({ teams: stillValid });
    }
    renderTeamList(els.teamSearch.value);
    updateTeamToggleLabel();
  }

  // Portaled to <body> while open so the popup body's overflow:auto can't clip
  // it (team_dropdown.png fix — shared helper, replaces the old bespoke toggle
  // + two outside-click document handlers). onOpen resets/focuses the search.
  wirePortalDropdown(els.teamToggle, els.teamPanel, {
    onOpen: () => {
      els.teamSearch.value = "";
      renderTeamList("");
      els.teamSearch.focus();
    },
  });
  els.teamSearch.addEventListener("input", () => renderTeamList(els.teamSearch.value));
  els.teamClear.addEventListener("click", () => {
    store.set({ teams: [] });
    renderTeamList(els.teamSearch.value);
    updateTeamToggleLabel();
    onChange();
  });

  // ── Team mode (owner decision 46) ──────────────────────────────────────────
  // The Team section is a dual control: a mode dropdown ("Current team" |
  // "Historic team") plus the picker. "Current team" is today's team filter
  // (innings actually played FOR that team, state.teams). "Historic team" is
  // the old "Has ever played for (career)" filter (profile.teams — the same
  // teams_played_for semi-join, decision 46 absorbed it here). Exactly one is
  // active at a time: switching mode clears the other field so there's never a
  // second, hidden team filter. `teamMode` is UI-only (not persisted in the
  // store); on open it's derived from whichever field currently holds a value.
  //
  // "Historic team" is profile-sheet-derived → men-only (decision 21). On the
  // Women view we hide the mode dropdown and the historic picker entirely and
  // force Current mode, so women get a live Team filter with no inert option.
  let teamMode = deriveTeamMode();

  function deriveTeamMode() {
    const s = store.get();
    return s.gender !== "female" && (s.profile.teams || []).length > 0 && (s.teams || []).length === 0
      ? "historic"
      : "current";
  }

  function applyTeamMode() {
    const isWomen = store.get().gender === "female";
    if (isWomen) teamMode = "current";
    els.teamModeGroup.hidden = isWomen; // women: no mode choice (historic is men-only)
    els.teamMode.value = teamMode;
    els.teamCurrentGroup.hidden = teamMode !== "current";
    els.teamHistoricGroup.hidden = isWomen || teamMode !== "historic";
  }

  els.teamMode.addEventListener("change", () => {
    const next = els.teamMode.value === "historic" ? "historic" : "current";
    if (next === teamMode) return;
    teamMode = next;
    // Clear the OTHER mode's selection so only one team filter is ever active.
    if (teamMode === "historic") store.set({ teams: [] });
    else setProfile({ teams: [] });
    applyTeamMode();
    updateTeamToggleLabel();
    renderTeamList(els.teamSearch.value);
    updateProfTeamLabel();
    renderProfTeamList(els.profTeamSearch.value);
    onChange();
  });

  // ── Profile filters (D4.2) ──────────────────────────────────────────────────
  // Option lists come from player_profiles (only values that have matched
  // players — so no dead options). Loaded once; the semi-join lives in
  // buildScopeClauses via profileSemiJoinSql.
  let profileOptions = { roleGroups: [], subByGroup: {}, bowlingTypes: [], battingHands: [], teams: [] };
  let profileOptionsLoadToken = 0;
  let profileOptionsErrored = false;

  function optionsHTML(values, selected, anyLabel) {
    const opts = [`<option value="">${anyLabel}</option>`];
    for (const v of values) {
      opts.push(`<option value="${escAttr(v)}" ${v === selected ? "selected" : ""}>${v}</option>`);
    }
    return opts.join("");
  }

  function renderRoleSelects() {
    const p = store.get().profile;
    els.roleGroup.innerHTML = optionsHTML(profileOptions.roleGroups, p.roleGroup, "Any role");
    const subs = p.roleGroup ? profileOptions.subByGroup[p.roleGroup] || [] : [];
    if (subs.length > 0) {
      els.roleSub.innerHTML = optionsHTML(subs, p.roleSub, "Any");
      els.roleSub.hidden = false;
    } else {
      els.roleSub.innerHTML = "";
      els.roleSub.hidden = true;
    }
  }

  function renderProfSelects() {
    const p = store.get().profile;
    els.battingHand.innerHTML = optionsHTML(profileOptions.battingHands, p.battingHand, "Any");
    els.bowlingType.innerHTML = optionsHTML(profileOptions.bowlingTypes, p.bowlingType, "Any");
  }

  function updateProfTeamLabel() {
    const teams = store.get().profile.teams;
    els.profTeamToggle.textContent =
      teams.length === 0 ? "Any team" : teams.length === 1 ? teams[0] : `${teams.length} teams`;
  }

  function renderProfTeamList(filterText) {
    const q = (filterText || "").trim().toLowerCase();
    const selected = new Set(store.get().profile.teams);
    // Cap the rendered list — the vocabulary is ~2,000 teams; show matches only.
    const filtered = profileOptions.teams.filter((t) => t.toLowerCase().includes(q)).slice(0, 200);
    els.profTeamList.innerHTML =
      filtered
        .map(
          (t) => `<label class="team-dropdown__item">
          <input type="checkbox" data-team="${escAttr(t)}" ${selected.has(t) ? "checked" : ""} />
          <span>${escHtml(t)}</span>
        </label>`
        )
        .join("") || `<p class="team-dropdown__empty">No teams match.</p>`;

    els.profTeamList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const cur = new Set(store.get().profile.teams);
        if (cb.checked) cur.add(cb.dataset.team);
        else cur.delete(cb.dataset.team);
        setProfile({ teams: [...cur] });
        updateProfTeamLabel();
        onChange();
      });
    });
  }

  function setProfile(patch) {
    store.set({ profile: { ...store.get().profile, ...patch } });
  }

  /** Profiles are men-only (decision 21). On the Women view the profile-sheet
   * dropdowns (Role, Batting hand, Bowling style) don't exist at all, so we
   * REMOVE them (hide, not grey — owner decision 46) and show the honest
   * disclaimer. R. Pos. is innings-derived, not profile-derived, so it stays
   * live for women (handled by its own controller). The historic-team picker
   * (also profile-derived) is hidden on women by applyTeamMode(). */
  function syncProfileEnabled() {
    const isWomen = store.get().gender === "female";
    els.profileNote.hidden = !isWomen;
    els.roleFilterGroup.hidden = isWomen;
    els.handFilterGroup.hidden = isWomen;
    els.bowlingFilterGroup.hidden = isWomen;
  }

  async function loadProfileOptions() {
    const token = ++profileOptionsLoadToken;
    try {
      // Batch 5b C4: bowling_type / batting_style / teams_played_for used to
      // be three separate DISTINCT scans over `profiles`; they're now three
      // parallel scalar-subquery aggregates in ONE query (one round trip).
      // Each subquery keeps the EXACT same FROM/WHERE as its old standalone
      // query — only DISTINCT-as-multiple-rows became list(DISTINCT …)-as-
      // one-array — so the option sets are provably unchanged. role_group/
      // role_subgroup was already a single combined query; left as-is.
      const [roleRows, optionRows] = await Promise.all([
        query(`SELECT DISTINCT role_group, role_subgroup FROM profiles WHERE role_group IS NOT NULL`),
        query(
          [
            `SELECT`,
            `  (SELECT list(DISTINCT bowling_type) FROM profiles WHERE bowling_type IS NOT NULL) AS bowling_types,`,
            `  (SELECT list(DISTINCT batting_style) FROM profiles WHERE batting_style IS NOT NULL) AS batting_styles,`,
            `  (SELECT list(DISTINCT team) FROM (SELECT UNNEST(string_split(teams_played_for, '|')) AS team FROM profiles WHERE teams_played_for IS NOT NULL) WHERE team <> '') AS teams`,
          ].join("\n")
        ),
      ]);
      if (token !== profileOptionsLoadToken) return; // a newer request superseded this one
      const groups = new Set();
      const subByGroup = {};
      for (const r of roleRows.rows) {
        groups.add(r.role_group);
        if (r.role_subgroup) (subByGroup[r.role_group] ||= []).push(r.role_subgroup);
      }
      for (const g of Object.keys(subByGroup)) subByGroup[g] = orderBy(subByGroup[g], ROLE_SUB_ORDER);
      const optRow = optionRows.rows[0] ?? {};
      const teams = (optRow.teams ?? []).slice().sort();
      profileOptions = {
        roleGroups: orderBy([...groups], ROLE_GROUP_ORDER),
        subByGroup,
        bowlingTypes: orderBy(optRow.bowling_types ?? [], BOWLING_TYPE_ORDER),
        battingHands: orderBy(optRow.batting_styles ?? [], BATTING_HAND_ORDER),
        teams,
      };
      profileOptionsErrored = false;
    } catch (e) {
      if (token !== profileOptionsLoadToken) return;
      // Don't reset profileOptions to empty here — a prior successful load (or
      // the initial all-empty defaults) is left as-is, and the error note below
      // makes the failure honest instead of silently reading as "no options".
      profileOptionsErrored = true;
    }
    renderRoleSelects();
    renderProfSelects();
    renderProfTeamList("");
    updateProfTeamLabel();
    syncProfileEnabled();
    els.profileLoadError.hidden = !profileOptionsErrored;
  }

  els.roleGroup.addEventListener("change", () => {
    // Changing the broad role invalidates any detailed sub-role.
    setProfile({ roleGroup: els.roleGroup.value || null, roleSub: null });
    renderRoleSelects();
    onChange();
  });
  els.roleSub.addEventListener("change", () => {
    setProfile({ roleSub: els.roleSub.value || null });
    onChange();
  });
  els.battingHand.addEventListener("change", () => {
    setProfile({ battingHand: els.battingHand.value || null });
    onChange();
  });
  els.bowlingType.addEventListener("change", () => {
    setProfile({ bowlingType: els.bowlingType.value || null });
    onChange();
  });

  // Portaled to <body> while open (team_dropdown.png fix — shared helper).
  wirePortalDropdown(els.profTeamToggle, els.profTeamPanel, {
    onOpen: () => {
      els.profTeamSearch.value = "";
      renderProfTeamList("");
      els.profTeamSearch.focus();
    },
  });
  els.profTeamSearch.addEventListener("input", () => renderProfTeamList(els.profTeamSearch.value));
  els.profTeamClear.addEventListener("click", () => {
    setProfile({ teams: [] });
    renderProfTeamList(els.profTeamSearch.value);
    updateProfTeamLabel();
    onChange();
  });

  // ── Position filters / Advanced (opposition + stat conditions) ─────────────
  // extracted, see src/drawerInnings.js and src/advanced.js. Two position
  // controls share the Player-profile slot and self-hide by mode (decision 46):
  //   regularPositionController — R. Pos. (state.regularPositions), plain mode.
  //   positionController        — striker/own batting position (state.positions),
  //                               matchup mode only.
  const regularPositionController = mountRegularPositions(els.rposHost, store, onChange);
  const positionController = mountBattingPosition(els.matchupPositionsHost, store, onChange);
  // Opposition is now a condition TYPE inside the unified builder (advanced.js
  // mounts it internally, embedded); it still reads/writes state.opposition.
  const advancedController = mountAdvanced(els.advancedHost, store, onChange);

  // ── Validation (popup "Search" button) ────────────────────────────────────
  // The popup's Search button (main.js) calls this before running the query:
  // decision 42 — a condition with a metric but no value blocks the search with
  // an inline row message (advancedController.validate() shows it, focuses the
  // row, returns false) rather than being silently dropped.
  function validate() {
    return advancedController.validate();
  }

  // ── Popup open/close hooks ─────────────────────────────────────────────────
  // Batch 3 fix 1 safety net: a snapshot of state.advanced taken at open time.
  // Stat-condition selects/value-changes already call onChange() themselves on
  // every committed edit (advanced.js), but a value mid-typed (store updated on
  // "input", no "change" yet because the field never blurred) would otherwise
  // reach a popup-close (Escape/backdrop/×) without ever telling main.js — the
  // pills/subtitle would silently keep reading the PRE-edit scope. Comparing at
  // onHide() and firing onChange() once if it moved closes that gap regardless
  // of which close route was used. (main.js owns the popup's actual show/hide,
  // ×, backdrop and Escape; these are just the hooks it calls on each.)
  let advancedSnapshotAtOpen = null;

  function onShow() {
    // Re-derive the (UI-only) team mode from current state each time the popup
    // opens, so it reflects any team/profile/gender change made while closed.
    teamMode = deriveTeamMode();
    advancedSnapshotAtOpen = JSON.stringify(store.get().advanced);
    // Drop a never-filled opposition row from a previous popup session before
    // syncing, so its visibility is re-derived purely from state.opposition.
    advancedController.onPopupShow();
    // Retry any option-fetches that previously failed — matches the inline
    // error copy's "reopen the filters to retry" (Batch 2 review). sync() and
    // loadProfileOptions() no-op cheaply when nothing needs refetching.
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

  // ── render / sync ────────────────────────────────────────────────────────────
  /** Re-render every control's value/disabled state from the store — cheap,
   * no network. */
  function renderControls() {
    updateTeamToggleLabel();
    applyTeamMode();
    renderRoleSelects();
    renderProfSelects();
    updateProfTeamLabel();
    syncProfileEnabled();
  }

  /** Called by main.js after every filter change: re-sync control states plus
   * the option lists (team) — each refetches only when its own scope key
   * actually changed, so repeated calls are cheap. */
  function sync() {
    renderControls();
    refreshTeamOptions();
    regularPositionController.sync();
    positionController.sync();
    // The unified condition builder re-gates its metric dropdowns (§8.9 phase
    // gating) and re-syncs the embedded opposition option list — the same
    // re-render main.js used to trigger when the panel lived on the page.
    advancedController.sync();
  }

  /** Badge count for the "All filters" button: only filters ACTUALLY applied
   * right now (inert kept-selections — positions while bowling, opposition
   * outside international — don't count, matching the pills). */
  function activeCount() {
    const s = store.get();
    let n = 0;
    if (s.teams && s.teams.length > 0) n++;
    if (s.gender !== "female") {
      const p = s.profile;
      if (p.roleGroup) n++;
      if (p.roleSub) n++;
      if (p.battingHand) n++;
      if (p.bowlingType) n++;
      if (p.teams && p.teams.length > 0) n++;
    }
    if (positionsFilterActive(s)) n++;
    if (regularPositionsFilterActive(s)) n++;
    if (oppositionFilterActive(s)) n++;
    n += activeConditionCount(s.advanced);
    return n;
  }

  loadProfileOptions();
  renderControls();

  // main.js gates sync() to only run while the popup is actually visible
  // (Batch 3 fix 2): the content must be fully current whenever VISIBLE
  // (onShow() calls sync() directly; the store.subscribe hook calls it too,
  // but only while the popup is open), never while hidden, where it would just
  // be wasted rebuild work (and, before this fix, the reason typing in the
  // advanced panel or the main search box lost focus/cursor on every keystroke).
  return { onShow, onHide, sync, activeCount, validate };
}
