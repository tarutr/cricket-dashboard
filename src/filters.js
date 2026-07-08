// src/filters.js
//
// The filter bar (SPEC §5.1, with owner adjustments from the Phase 2 brief):
// Gender segmented control, Format chips (5 buckets), Date range (month+year),
// Team multi-select (checkbox dropdown with search), Team type, Min innings.
// Advanced filters (AND/OR condition builder) live in src/advanced.js.
//
// This module only renders/wires the DOM and calls store.set(...); it never
// queries the database directly — src/table.js owns re-querying on state change.

import { FORMAT_BUCKETS, expandFormats, emptyProfile, hasActiveProfileFilter, profileSemiJoinSql } from "./state.js";
import { query } from "./db.js";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

function escAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function monthOptionsHTML(minMonth, maxMonth, selected) {
  if (!minMonth || !maxMonth) return "";
  const [minY, minM] = minMonth.split("-").map(Number);
  const [maxY, maxM] = maxMonth.split("-").map(Number);
  const opts = [];
  for (let y = maxY; y >= minY; y--) {
    const mFrom = y === maxY ? maxM : 12;
    const mTo = y === minY ? minM : 1;
    for (let m = mFrom; m >= mTo; m--) {
      const val = `${y}-${String(m).padStart(2, "0")}`;
      opts.push(`<option value="${val}" ${val === selected ? "selected" : ""}>${MONTH_NAMES[m - 1]} ${y}</option>`);
    }
  }
  return opts.join("");
}

function esc(s) {
  return String(s).replace(/'/g, "''");
}

/**
 * Query DISTINCT teams present under the current gender+format+date+team_type
 * scope (excluding the team filter itself, and excluding minInnings/search —
 * those don't affect which teams exist). batting_team for batting, bowling_team
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

/** Shared WHERE-clause builder for gender/format/date/team_type/(team) — used by
 * both the team-options lookup and src/table.js's main query. Exported so
 * table.js builds an identical scope. */
export function buildScopeClauses(state, { includeTeams = true, teamColumn, idColumn } = {}) {
  const clauses = [];
  clauses.push(`gender = '${esc(state.gender)}'`);

  const matchTypes = expandFormats(state.formats);
  if (matchTypes.length === 0) {
    clauses.push("FALSE"); // no format selected -> no rows, never "all"
  } else {
    clauses.push(`match_type IN (${matchTypes.map((t) => `'${esc(t)}'`).join(", ")})`);
  }

  if (state.dateFrom) clauses.push(`match_date >= DATE '${esc(state.dateFrom)}-01'`);
  if (state.dateTo) {
    // Inclusive of the whole "to" month: use the first day of the FOLLOWING month.
    const [y, m] = state.dateTo.split("-").map(Number);
    const nextY = m === 12 ? y + 1 : y;
    const nextM = m === 12 ? 1 : m + 1;
    clauses.push(`match_date < DATE '${nextY}-${String(nextM).padStart(2, "0")}-01'`);
  }

  if (state.teamType === "international") clauses.push(`team_type = 'international'`);
  else if (state.teamType === "club") clauses.push(`team_type = 'club'`);
  // "both" -> no predicate

  if (includeTeams && state.teams && state.teams.length > 0 && teamColumn) {
    clauses.push(`${teamColumn} IN (${state.teams.map((t) => `'${esc(t)}'`).join(", ")})`);
  }

  // Profile-powered filters (D4.2): semi-join to matched player_ids. Only added
  // when an idColumn is supplied by the caller (the player_matches/innings views
  // and matchup views all have a join key; some scoped lookups don't) and a
  // profile filter is active. profileSemiJoinSql itself no-ops for women.
  if (idColumn) {
    const profileClause = profileSemiJoinSql(state, idColumn);
    if (profileClause) clauses.push(profileClause);
  }

  return clauses;
}

/**
 * Mount the filter bar into `container`. Calls `onChange()` after any state
 * mutation so the caller (main.js) can re-render the table. Returns an object
 * with `refreshTeamOptions()` so table.js/main.js can force a repopulate.
 */
export function mountFilters(container, store, onChange, onFormatsChanged) {
  container.innerHTML = `
    <div class="filter-bar">
      <div class="filter-group filter-group--gender">
        <span class="filter-label">Gender</span>
        <div class="segmented" data-role="gender" role="group" aria-label="Gender">
          <button type="button" class="segmented__btn" data-value="female">Women</button>
          <button type="button" class="segmented__btn" data-value="male">Men</button>
        </div>
      </div>

      <div class="filter-group filter-group--format">
        <span class="filter-label">Format</span>
        <div class="chip-group" data-role="formats" role="group" aria-label="Format">
          ${FORMAT_BUCKETS.map(
            (b) => `<button type="button" class="chip" data-value="${b.key}">${b.label}</button>`
          ).join("")}
        </div>
      </div>

      <div class="filter-group filter-group--dates">
        <span class="filter-label">Date range</span>
        <div class="date-range">
          <select class="select" data-role="dateFrom" aria-label="From"></select>
          <span class="date-range__sep">–</span>
          <select class="select" data-role="dateTo" aria-label="To"></select>
        </div>
      </div>

      <div class="filter-group filter-group--team">
        <span class="filter-label">Team</span>
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

      <div class="filter-group filter-group--teamtype">
        <span class="filter-label">Team type</span>
        <div class="segmented" data-role="teamType" role="group" aria-label="Team type">
          <button type="button" class="segmented__btn" data-value="international">International</button>
          <button type="button" class="segmented__btn" data-value="club">Club</button>
          <button type="button" class="segmented__btn" data-value="both">Both</button>
        </div>
      </div>

      <div class="filter-group filter-group--mininnings">
        <label class="filter-label" for="min-innings-input">Min innings</label>
        <input type="number" id="min-innings-input" class="input input--number" data-role="minInnings" min="1" step="1" />
      </div>
    </div>

    <div class="filter-bar filter-bar--profile" data-role="profile-bar">
      <div class="filter-group filter-group--profile-head">
        <span class="filter-label">Player profile</span>
        <span class="profile-note" data-role="profile-note" hidden>We don't have profile data on Women yet.</span>
      </div>

      <div class="filter-group filter-group--role">
        <label class="filter-label" for="prof-roleGroup">Role</label>
        <div class="profile-role">
          <select class="select" id="prof-roleGroup" data-role="prof-roleGroup" aria-label="Playing role"></select>
          <select class="select" data-role="prof-roleSub" aria-label="Detailed role" hidden></select>
        </div>
      </div>

      <div class="filter-group filter-group--hand">
        <label class="filter-label" for="prof-battingHand">Batting hand</label>
        <select class="select" id="prof-battingHand" data-role="prof-battingHand" aria-label="Batting hand"></select>
      </div>

      <div class="filter-group filter-group--bowling">
        <label class="filter-label" for="prof-bowlingType">Bowling</label>
        <select class="select" id="prof-bowlingType" data-role="prof-bowlingType" aria-label="Bowling type"></select>
      </div>

      <div class="filter-group filter-group--profteams">
        <span class="filter-label">Teams played for</span>
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
  `;

  const els = {
    gender: container.querySelector('[data-role="gender"]'),
    formats: container.querySelector('[data-role="formats"]'),
    dateFrom: container.querySelector('[data-role="dateFrom"]'),
    dateTo: container.querySelector('[data-role="dateTo"]'),
    teamToggle: container.querySelector('[data-role="team-toggle"]'),
    teamPanel: container.querySelector('[data-role="team-panel"]'),
    teamSearch: container.querySelector('[data-role="team-search"]'),
    teamList: container.querySelector('[data-role="team-list"]'),
    teamClear: container.querySelector('[data-role="team-clear"]'),
    teamType: container.querySelector('[data-role="teamType"]'),
    minInnings: container.querySelector('[data-role="minInnings"]'),
    profileBar: container.querySelector('[data-role="profile-bar"]'),
    profileNote: container.querySelector('[data-role="profile-note"]'),
    roleGroup: container.querySelector('[data-role="prof-roleGroup"]'),
    roleSub: container.querySelector('[data-role="prof-roleSub"]'),
    battingHand: container.querySelector('[data-role="prof-battingHand"]'),
    bowlingType: container.querySelector('[data-role="prof-bowlingType"]'),
    profTeamToggle: container.querySelector('[data-role="profteam-toggle"]'),
    profTeamPanel: container.querySelector('[data-role="profteam-panel"]'),
    profTeamSearch: container.querySelector('[data-role="profteam-search"]'),
    profTeamList: container.querySelector('[data-role="profteam-list"]'),
    profTeamClear: container.querySelector('[data-role="profteam-clear"]'),
  };

  let teamOptionsCache = []; // all available team names for the current scope
  let lastTeamScopeKey = null;

  function scopeKeyFor(state) {
    return JSON.stringify([state.discipline, state.gender, state.formats, state.dateFrom, state.dateTo, state.teamType]);
  }

  function syncSegmented(el, value) {
    el.querySelectorAll(".segmented__btn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.value === value);
    });
  }

  function syncChips(el, values) {
    el.querySelectorAll(".chip").forEach((btn) => {
      btn.classList.toggle("is-active", values.includes(btn.dataset.value));
    });
  }

  function syncDateOptions(minMonth, maxMonth, state) {
    els.dateFrom.innerHTML = monthOptionsHTML(minMonth, maxMonth, state.dateFrom);
    els.dateTo.innerHTML = monthOptionsHTML(minMonth, maxMonth, state.dateTo);
  }

  function renderTeamList(filterText) {
    const q = (filterText || "").trim().toLowerCase();
    const selected = new Set(store.get().teams);
    const filtered = teamOptionsCache.filter((t) => t.toLowerCase().includes(q));
    els.teamList.innerHTML = filtered
      .map(
        (t) => `<label class="team-dropdown__item">
          <input type="checkbox" data-team="${t.replace(/"/g, "&quot;")}" ${selected.has(t) ? "checked" : ""} />
          <span>${t}</span>
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

  async function refreshTeamOptions({ preserveSelection = true } = {}) {
    const state = store.get();
    const key = scopeKeyFor(state);
    if (key === lastTeamScopeKey) return;
    lastTeamScopeKey = key;
    try {
      teamOptionsCache = await fetchTeamOptions(state);
    } catch (e) {
      teamOptionsCache = [];
    }
    if (preserveSelection) {
      const validSet = new Set(teamOptionsCache);
      const stillValid = state.teams.filter((t) => validSet.has(t));
      if (stillValid.length !== state.teams.length) {
        store.set({ teams: stillValid });
      }
    }
    renderTeamList(els.teamSearch.value);
    updateTeamToggleLabel();
  }

  // ── Profile filters (D4.2) ──────────────────────────────────────────────────
  // Option lists come from player_profiles (only values that have matched
  // players — so no dead options). Loaded once; the semi-join lives in
  // buildScopeClauses via profileSemiJoinSql.
  let profileOptions = { roleGroups: [], subByGroup: {}, bowlingTypes: [], battingHands: [], teams: [] };

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
          <span>${t}</span>
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

  /** Grey the whole profile row out for women (profiles are men-only, decision 21). */
  function syncProfileEnabled() {
    const disabled = store.get().gender === "female";
    els.profileBar.classList.toggle("is-disabled", disabled);
    els.profileNote.hidden = !disabled;
    [els.roleGroup, els.roleSub, els.battingHand, els.bowlingType, els.profTeamToggle].forEach((el) => {
      el.disabled = disabled;
    });
    if (disabled) {
      els.profTeamPanel.hidden = true;
      els.profTeamToggle.setAttribute("aria-expanded", "false");
    }
  }

  async function loadProfileOptions() {
    try {
      const [roleRows, bowlRows, handRows, teamRows] = await Promise.all([
        query(`SELECT DISTINCT role_group, role_subgroup FROM profiles WHERE role_group IS NOT NULL`),
        query(`SELECT DISTINCT bowling_type FROM profiles WHERE bowling_type IS NOT NULL`),
        query(`SELECT DISTINCT batting_style FROM profiles WHERE batting_style IS NOT NULL`),
        query(
          `SELECT DISTINCT team FROM (SELECT UNNEST(string_split(teams_played_for, '|')) AS team FROM profiles WHERE teams_played_for IS NOT NULL) WHERE team <> '' ORDER BY team`
        ),
      ]);
      const groups = new Set();
      const subByGroup = {};
      for (const r of roleRows.rows) {
        groups.add(r.role_group);
        if (r.role_subgroup) (subByGroup[r.role_group] ||= []).push(r.role_subgroup);
      }
      for (const g of Object.keys(subByGroup)) subByGroup[g] = orderBy(subByGroup[g], ROLE_SUB_ORDER);
      profileOptions = {
        roleGroups: orderBy([...groups], ROLE_GROUP_ORDER),
        subByGroup,
        bowlingTypes: orderBy(bowlRows.rows.map((r) => r.bowling_type), BOWLING_TYPE_ORDER),
        battingHands: orderBy(handRows.rows.map((r) => r.batting_style), BATTING_HAND_ORDER),
        teams: teamRows.rows.map((r) => r.team),
      };
    } catch (e) {
      profileOptions = { roleGroups: [], subByGroup: {}, bowlingTypes: [], battingHands: [], teams: [] };
    }
    renderRoleSelects();
    renderProfSelects();
    renderProfTeamList("");
    updateProfTeamLabel();
    syncProfileEnabled();
  }

  function render() {
    const state = store.get();
    syncSegmented(els.gender, state.gender);
    syncChips(els.formats, state.formats);
    syncSegmented(els.teamType, state.teamType);
    els.minInnings.value = state.minInnings;
    updateTeamToggleLabel();
    renderRoleSelects();
    renderProfSelects();
    updateProfTeamLabel();
    syncProfileEnabled();
  }

  // ---- wire events ----
  els.gender.addEventListener("click", (e) => {
    const btn = e.target.closest(".segmented__btn");
    if (!btn) return;
    // Switching gender clears team + profile filters: teams differ by gender, and
    // profile filters are men-only (cleared so the women's view is never silently
    // empty — the profile controls also grey out below, decision 21).
    store.set({ gender: btn.dataset.value, teams: [], profile: emptyProfile() });
    render();
    syncProfileEnabled();
    refreshTeamOptions().then(onChange);
    onChange();
  });

  els.formats.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    const state = store.get();
    const value = btn.dataset.value;
    const set = new Set(state.formats);
    if (set.has(value)) set.delete(value);
    else set.add(value);
    store.set({ formats: [...set], teams: [] });
    render();
    if (onFormatsChanged) onFormatsChanged();
    refreshTeamOptions().then(onChange);
    onChange();
  });

  els.dateFrom.addEventListener("change", () => {
    store.set({ dateFrom: els.dateFrom.value });
    refreshTeamOptions().then(onChange);
    onChange();
  });
  els.dateTo.addEventListener("change", () => {
    store.set({ dateTo: els.dateTo.value });
    refreshTeamOptions().then(onChange);
    onChange();
  });

  els.teamType.addEventListener("click", (e) => {
    const btn = e.target.closest(".segmented__btn");
    if (!btn) return;
    store.set({ teamType: btn.dataset.value, teams: [] });
    render();
    refreshTeamOptions().then(onChange);
    onChange();
  });

  els.minInnings.addEventListener("change", () => {
    const v = Math.max(1, parseInt(els.minInnings.value, 10) || 1);
    els.minInnings.value = v;
    store.set({ minInnings: v });
    onChange();
  });

  els.teamToggle.addEventListener("click", () => {
    const isOpen = !els.teamPanel.hidden;
    els.teamPanel.hidden = isOpen;
    els.teamToggle.setAttribute("aria-expanded", String(!isOpen));
    if (!isOpen) {
      els.teamSearch.value = "";
      renderTeamList("");
      els.teamSearch.focus();
    }
  });
  document.addEventListener("click", (e) => {
    if (!container.contains(e.target)) return;
    if (e.target.closest('[data-role="team-dropdown"]')) return;
    els.teamPanel.hidden = true;
    els.teamToggle.setAttribute("aria-expanded", "false");
  });
  document.addEventListener("click", (e) => {
    if (container.contains(e.target)) return;
    els.teamPanel.hidden = true;
    els.teamToggle.setAttribute("aria-expanded", "false");
  });

  els.teamSearch.addEventListener("input", () => renderTeamList(els.teamSearch.value));
  els.teamClear.addEventListener("click", () => {
    store.set({ teams: [] });
    renderTeamList(els.teamSearch.value);
    updateTeamToggleLabel();
    onChange();
  });

  // ---- wire profile-filter events ----
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

  els.profTeamToggle.addEventListener("click", () => {
    if (els.profTeamToggle.disabled) return;
    const isOpen = !els.profTeamPanel.hidden;
    els.profTeamPanel.hidden = isOpen;
    els.profTeamToggle.setAttribute("aria-expanded", String(!isOpen));
    if (!isOpen) {
      els.profTeamSearch.value = "";
      renderProfTeamList("");
      els.profTeamSearch.focus();
    }
  });
  document.addEventListener("click", (e) => {
    if (container.contains(e.target) && e.target.closest('[data-role="profteam-dropdown"]')) return;
    els.profTeamPanel.hidden = true;
    els.profTeamToggle.setAttribute("aria-expanded", "false");
  });
  els.profTeamSearch.addEventListener("input", () => renderProfTeamList(els.profTeamSearch.value));
  els.profTeamClear.addEventListener("click", () => {
    setProfile({ teams: [] });
    renderProfTeamList(els.profTeamSearch.value);
    updateProfTeamLabel();
    onChange();
  });

  loadProfileOptions();

  render();

  return {
    render,
    refreshTeamOptions,
    setDateBounds(minMonth, maxMonth) {
      syncDateOptions(minMonth, maxMonth, store.get());
    },
  };
}
