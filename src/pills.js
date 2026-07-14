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

import { positionsFilterActive, regularPositionsFilterActive, oppositionFilterActive, eventFilterActive, venueFilterActive, hasActiveProfileFilter, matchupVsActive, effectiveNamespace } from "./state.js";
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
 *
 * `onPinChange` (task 3b, owner decision 46) is a separate hook for a
 * PINNED-PLAYER pill's × — retained so a caller could ever treat un-pinning
 * differently from a filter-pill removal. As of R3 Wave 2 (item 7b) it makes
 * no difference: main.js wires BOTH to the same immediate-requery path, since
 * removing any pill edits the already-searched result set and the table must
 * reflect the remaining conditions at once (see main.js mountTableToolbarExtras
 * for the rationale). Defaults to `onChange` so a caller that never pins
 * anything — and every caller now that the two paths are identical — needs to
 * pass only one callback.
 */
export function mountPills(container, store, onChange, onPinChange = onChange) {
  function render() {
    const s = store.get();
    const pills = []; // { label, remove(), requery? }

    // "Current team" mode (owner decision 46): one removable pill per team,
    // prefixed "Team:" to distinguish it from the "Historic team" (Ever played
    // for) pill below.
    for (const t of s.teams || []) {
      pills.push({
        label: `Team: ${t}`,
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
      // The "Historic team" (Ever played for) pill is gone — owner 1B-2 removed
      // the Current/Historic distinction; profile.teams is no longer set by any
      // UI, so there is nothing to render here.
    }

    if (positionsFilterActive(s)) {
      const sorted = [...s.positions].sort((a, b) => a - b);
      // Bowling-matchup mode (D4-R4): the filter narrows the batters faced,
      // not the bowler's own (nonexistent) batting position.
      const bowlingMatchup = s.discipline === "bowling" && matchupVsActive(s);
      const label = bowlingMatchup ? `To batters at ${sorted.join(", ")}` : `Batting at ${sorted.join(", ")}`;
      pills.push({ label, remove: () => store.set({ positions: [] }) });
    }

    // R. Pos. (owner decision 46) — plain-mode filter on a player's most common
    // batting position within scope.
    if (regularPositionsFilterActive(s)) {
      const sorted = [...s.regularPositions].sort((a, b) => a - b);
      pills.push({ label: `R. Pos. ${sorted.join(", ")}`, remove: () => store.set({ regularPositions: [] }) });
    }

    if (oppositionFilterActive(s)) {
      const label = s.opposition.length === 1 ? `vs ${s.opposition[0]}` : `vs ${s.opposition.length} opponents`;
      pills.push({ label, remove: () => store.set({ opposition: [] }) });
    }

    // Event / Venue (Batch 1B): one removable pill per selected value, prefixed
    // so the honest scope reads plainly. Both are gender-scoped match filters.
    if (eventFilterActive(s)) {
      for (const e of s.event) {
        pills.push({ label: `Event: ${e}`, remove: () => store.set({ event: store.get().event.filter((x) => x !== e) }) });
      }
    }
    if (venueFilterActive(s)) {
      for (const v of s.venue) {
        pills.push({ label: `Venue: ${v}`, remove: () => store.set({ venue: store.get().venue.filter((x) => x !== v) }) });
      }
    }

    // Free-text player-name filter (state.search) — written by the new "Name"
    // condition in the Filters popup (ROUND 3 task 6) and by omnisearch's
    // "Filter the table to names matching …" action. Both are the same ILIKE
    // filter, so one pill covers both. Labelled "Name: X" (task 6) — a shade
    // shorter/clearer than describeScope()'s `matching "X"` subtitle token; the
    // two describe the same filter, so the honest-scope invariant still holds.
    if (s.search && s.search.trim()) {
      const term = s.search.trim();
      pills.push({ label: `Name: ${term}`, remove: () => store.set({ search: "" }) });
    }

    // Pinned players (task 3b): one removable "+ name" pill per pin. Inert
    // (greyed, with an explaining title) while matchup "Vs" mode is active —
    // pins only apply in plain mode (buildMatchupQuery is left completely
    // untouched, per decision 39's byte-identical-SQL rule) — but the × still
    // works either way, since un-pinning is always a valid, honest action.
    const matchupInert = matchupVsActive(s);
    for (const p of s.pinnedPlayers || []) {
      pills.push({
        label: `+ ${p.name}`,
        inert: matchupInert,
        title: matchupInert ? "Pinned players don't apply in matchup (Vs) mode" : null,
        requery: true,
        remove: () =>
          store.set({ pinnedPlayers: (store.get().pinnedPlayers || []).filter((x) => x.id !== p.id) }),
      });
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
          `<span class="pill${p.inert ? " pill--inert" : ""}"${p.title ? ` title="${esc(p.title)}"` : ""}>${esc(p.label)} <button type="button" class="pill__x" data-idx="${i}" aria-label="Remove filter">&times;</button></span>`
      )
      .join("")}</div>`;

    container.querySelectorAll(".pill__x").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        const p = pills[idx];
        p.remove();
        if (p.requery) onPinChange();
        else onChange();
      });
    });
  }

  render();

  return { render };
}
