// src/pills.js
//
// Applied-filter pills (owner decision 29): a removable-chip row under the
// scope strip reflecting filters that are ACTUALLY narrowing the result set
// right now. Honesty (SPEC §8.4) — an inert selection (e.g. a batting
// position picked while viewing bowling) shows no pill, matching the rule
// that describeScope() and every query already follow.
//
// B2R wave 2 (decision 42): stat-condition pills now read the condition
// itself ("Runs ≥ 300") instead of a count ("1 stat condition") — one pill
// per active condition, each independently removable via the same
// removeConditionAt() advanced.js's own remove-condition button uses, so the
// two paths can never diverge.
//
// This module renders/wires the DOM and calls store.set(...); it never
// queries the database.

import { positionsFilterActive, oppositionFilterActive, hasActiveProfileFilter, matchupVsActive, effectiveNamespace } from "./state.js";
import { isConditionComplete, removeConditionAt } from "./advanced.js";
import { metricsFor, getMetric } from "./metrics.js";
import { escHtml as esc } from "./html.js";

// Symbol style (not advanced.js's describeAdvanced() word style, "at least
// 300") — matches the worked examples in the brief ("Runs ≥ 300",
// "Innings ≥ 10") and is reused verbatim by state.js's describeScope() for
// the subtitle. The two can't share one function without state.js and
// pills.js importing each other (pills.js already imports several helpers
// FROM state.js) — see the near-identical helper + comment in state.js.
const OP_SYMBOLS = { gte: "≥", lte: "≤", eq: "=" };

function metricLabelFor(metricKey, state) {
  const ns = effectiveNamespace(state);
  const inNs = metricsFor(ns).find((m) => m.key === metricKey);
  const metric = inNs || getMetric(metricKey);
  return metric ? metric.label : metricKey;
}

function conditionPillLabel(cond, state) {
  const label = metricLabelFor(cond.metricKey, state);
  if (cond.operator === "between") return `${label} ${cond.v1}–${cond.v2}`;
  return `${label} ${OP_SYMBOLS[cond.operator] ?? cond.operator} ${cond.v1}`;
}

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

    // Free-text player-name search (omnisearch's explicit "Filter the table
    // to names matching …" action) — phrased exactly like describeScope()'s
    // `matching "…"` subtitle token so the pill and the honest scope sentence
    // never disagree (flagged: chose the subtitle's own wording over a
    // shorter bare-quote label for that reason).
    if (s.search && s.search.trim()) {
      const term = s.search.trim();
      pills.push({ label: `matching "${term}"`, remove: () => store.set({ search: "" }) });
    }

    // Stat conditions (decision 42): one pill per ACTIVE condition (metric +
    // valid value), reading the condition itself. Iterates the raw
    // state.advanced.groups (not advanced.js's activeGroups()) so gi/ci here
    // are the TRUE indices removeConditionAt() needs — activeGroups() filters
    // out incomplete rows first, which would shift indices whenever a blank
    // edit-row sits before a complete one.
    (s.advanced.groups || []).forEach((g, gi) => {
      g.conds.forEach((c, ci) => {
        if (!isConditionComplete(c)) return;
        pills.push({
          label: conditionPillLabel(c, s),
          remove: () => removeConditionAt(store, gi, ci),
        });
      });
    });

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
