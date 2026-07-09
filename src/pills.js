// src/pills.js
//
// Applied-filter pills (owner decision 29): a removable-chip row under the
// scope strip reflecting filters that are ACTUALLY narrowing the result set
// right now. Honesty (SPEC §8.4) — an inert selection (e.g. a batting
// position picked while viewing bowling) shows no pill, matching the rule
// that describeScope() and every query already follow.
//
// This module renders/wires the DOM and calls store.set(...); it never
// queries the database.

import { positionsFilterActive, oppositionFilterActive, hasActiveProfileFilter, matchupVsActive } from "./state.js";
import { activeConditionCount } from "./advanced.js";
import { escHtml as esc } from "./html.js";

/**
 * Mount the pills row into `container`. Calls `onChange()` after a pill's ×
 * mutates the store; the caller (main.js) re-renders downstream views (and
 * is expected to call `render()` again as part of that same pipeline, the
 * same way it re-syncs the drawer and advanced-filter count elsewhere).
 */
export function mountPills(container, store, onChange) {
  function render() {
    const s = store.get();
    const pills = []; // { label, remove() }

    for (const t of s.teams || []) {
      pills.push({
        label: t,
        remove: () => store.set({ teams: store.get().teams.filter((x) => x !== t) }),
      });
    }

    // Profile pills are men-only (decision 21) — inert while viewing women,
    // so no pill even if a stale value somehow lingered in state.
    if (s.gender !== "female" && hasActiveProfileFilter(s.profile)) {
      const p = s.profile;
      if (p.roleGroup) {
        pills.push({ label: p.roleGroup, remove: () => store.set({ profile: { ...store.get().profile, roleGroup: null } }) });
      }
      if (p.roleSub) {
        pills.push({ label: p.roleSub, remove: () => store.set({ profile: { ...store.get().profile, roleSub: null } }) });
      }
      if (p.battingHand) {
        pills.push({ label: p.battingHand, remove: () => store.set({ profile: { ...store.get().profile, battingHand: null } }) });
      }
      if (p.bowlingType) {
        pills.push({ label: p.bowlingType, remove: () => store.set({ profile: { ...store.get().profile, bowlingType: null } }) });
      }
      if (p.teams && p.teams.length > 0) {
        const label = p.teams.length <= 2 ? p.teams.join(", ") : `${p.teams.length} teams played for`;
        pills.push({ label, remove: () => store.set({ profile: { ...store.get().profile, teams: [] } }) });
      }
    }

    if (positionsFilterActive(s)) {
      const sorted = [...s.positions].sort((a, b) => a - b);
      // Bowling-matchup mode (D4-R4): the filter narrows the batters faced,
      // not the bowler's own (nonexistent) batting position.
      const bowlingMatchup = s.discipline === "bowling" && matchupVsActive(s);
      const label = bowlingMatchup ? `To batters at ${sorted.join(", ")}` : `Batting at ${sorted.join(", ")}`;
      pills.push({ label, remove: () => store.set({ positions: [] }) });
    }

    if (oppositionFilterActive(s)) {
      const label = s.opposition.length === 1 ? `vs ${s.opposition[0]}` : `vs ${s.opposition.length} opponents`;
      pills.push({ label, remove: () => store.set({ opposition: [] }) });
    }

    const conditionCount = activeConditionCount(s.advanced);
    if (conditionCount > 0) {
      pills.push({
        label: `${conditionCount} stat condition${conditionCount === 1 ? "" : "s"}`,
        remove: () => store.set({ advanced: { op: "AND", groups: [] } }),
      });
    }

    if (pills.length === 0) {
      container.innerHTML = "";
      return;
    }

    container.innerHTML = `<div class="pills-row">${pills
      .map(
        (p, i) =>
          `<span class="pill">${esc(p.label)} <button type="button" class="pill__x" data-idx="${i}" aria-label="Remove filter">&times;</button></span>`
      )
      .join("")}</div>`;

    container.querySelectorAll(".pill__x").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        pills[idx].remove();
        onChange();
      });
    });
  }

  render();

  return { render };
}
