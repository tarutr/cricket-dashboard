// src/pills.js
//
// Applied-filter pills (owner decision 29): a removable-chip row under the
// scope strip reflecting filters that are ACTUALLY narrowing the result set
// right now. Honesty (SPEC §8.4) — an inert selection (e.g. a batting
// position picked while viewing bowling) shows no pill, matching the rule
// that describeScope() and every query already follow.
//
// B2R wave 2 (decision 42): stat-condition pills read the condition itself
// ("Runs ≥ 300") instead of a count ("1 stat condition") — one pill per active
// condition, each independently removable. R5-A #9 made the pills derive from the
// APPLIED snapshot, so a condition pill's × removes the matching condition from
// the LIVE store by CONTENT (removeConditionByContent) rather than by index.
//
// This module renders/wires the DOM and calls store.set(...); it never
// queries the database.

import { positionsFilterActive, regularPositionsFilterActive, oppositionFilterActive, eventFilterActive, venueFilterActive, seasonsForEvent, hasActiveProfileFilter, matchupVsActive, effectiveNamespace, fieldingPositionActive, fieldingKindActive, fieldingPhaseActive, FIELDING_KIND_OPTIONS, FIELDING_PHASE_OPTIONS, resultFilterActive, tossResultFilterActive, tossDecisionFilterActive, inningsOrderFilterActive, stageFilterActive, methodFilterActive, RESULT_OPTIONS, TOSS_RESULT_OPTIONS, TOSS_DECISION_OPTIONS, INNINGS_ORDER_OPTIONS } from "./state.js";
import { isConditionComplete, isBowlingFiguresCondition } from "./advanced.js";
import { metricsFor, getMetric, metricDisplayLabel } from "./metrics.js";
import { escHtml as esc } from "./html.js";

// Symbol style (not a word phrasing like "at least 300") — matches the worked
// examples in the brief ("Runs ≥ 300",
// "Innings ≥ 10") and is reused verbatim by state.js's describeScope() for
// the subtitle. The two can't share one function without state.js and
// pills.js importing each other (pills.js already imports several helpers
// FROM state.js) — see the near-identical helper + comment in state.js.
const OP_SYMBOLS = { gte: "≥", lte: "≤", eq: "=" };

function metricLabelFor(metricKey, state) {
  const ns = effectiveNamespace(state);
  const inNs = metricsFor(ns).find((m) => m.key === metricKey);
  const metric = inNs || getMetric(metricKey);
  return metric ? metricDisplayLabel(metric, state.formats) : metricKey;
}

function conditionPillLabel(cond, state) {
  const label = metricLabelFor(cond.metricKey, state);
  // Best Bowling (Wave A2 item 2): two-box "≥ W wickets for ≤ R runs" — render
  // as "Best Bowling ≥2W for ≤9R" (W = v1, R = v2).
  if (isBowlingFiguresCondition(cond)) return `${label} ≥${cond.v1}W for ≤${cond.v2}R`;
  if (cond.operator === "between") return `${label} ${cond.v1}–${cond.v2}`;
  return `${label} ${OP_SYMBOLS[cond.operator] ?? cond.operator} ${cond.v1}`;
}

/**
 * Mount the pills row into `container`. Calls `onChange()` after a pill's ×/+
 * mutates the store; the caller (main.js) re-renders downstream views (and
 * is expected to call `render()` again as part of that same pipeline, the
 * same way it re-syncs the drawer and advanced-filter count elsewhere).
 *
 * `onPinChange` (task 3b, owner decision 46) is a separate hook retained so a
 * caller could ever treat un-pinning differently from a filter-pill removal.
 * As of the R4 Wave 4a ADDENDUM it makes no difference: every pill's ×/+ —
 * FILTER and PIN alike — goes through the same PENDING path (`onChange`:
 * soft-delete into the pending set, light the Search button, never re-query;
 * the table stays frozen until Search). The ADDENDUM's INSTANT behaviour is
 * scoped to *adding* a pin from the results search (main.js pinPlayer), NOT to
 * a pill's ×/+. Defaults to `onChange` so a caller that never pins anything
 * needs to pass only one callback.
 *
 * R5-A #9: `getState` returns the APPLIED snapshot (main.js passes
 * `() => appliedState`) — FILTER pills derive from it, so a filter edited inside
 * the Filters popup shows NO pill until the popup's Search commits it (reversing
 * Wave 4a's "pills reflect pending"). PIN pills instead read the LIVE store
 * directly (see render()), preserving the approved carve-outs: a pin added via
 * the results search shows instantly, and a pin ×/+ soft-delete stays pending.
 * Every pill's ×/+ still soft-deletes with a red-outline undo and commits on
 * Search (decision 47g); the staged set wins over active so a soft-deleted filter
 * keeps showing staged even though APPLIED still carries it until Search.
 *
 * `getNoInningsIds` (4d/A6): returns the Set of pinned player ids main.js
 * learned, from the LAST completed load(), have zero rows in the searched
 * scope (table.js's `missingPinnedIds`) — main.js is the only source of
 * truth for that (a query result), so this module just renders whatever it
 * reports. Defaults to an always-empty Set for any caller that never pins.
 */
export function mountPills(
  container,
  store,
  onChange,
  onPinChange = onChange,
  getState = () => store.get(),
  getNoInningsIds = () => new Set()
) {
  // R4 Wave 4a (A4): soft-delete-with-undo. A pill's × removes its effect from
  // the PENDING store (so the Search button lights, per A2) AND stages the pill
  // for display — it stays visible with a red outline and the × flipped to a +.
  // Clicking + re-adds the effect and returns the pill to normal. A staged pill
  // survives re-render (its effect is gone from state, so render() can't
  // re-derive it) via this Map, keyed by a stable pill key; each entry carries
  // the captured descriptor + a restore() closure. Cleared on the next Search /
  // Clear commit (clearStaged), at which point the removal is permanent.
  const staged = new Map();

  // R5-A #9: content-based condition remove/restore on the LIVE (pending) store's
  // current-discipline block (state.advanced). Filter pills now derive from the
  // APPLIED snapshot, so the applied gi/ci indices can drift from the live block —
  // matching by CONTENT keeps a pill's × removing the RIGHT live condition (and
  // no-ops safely if it isn't in the live block, e.g. after a pending discipline
  // switch). advanced stays the current discipline's block (R5-A #7), so this
  // writes to whichever discipline is active.
  function condMatches(a, b) {
    return (
      a.metricKey === b.metricKey &&
      a.operator === b.operator &&
      String(a.v1) === String(b.v1) &&
      String(a.v2) === String(b.v2)
    );
  }
  function removeConditionByContent(cond) {
    const adv = store.get().advanced;
    const groups = (adv.groups || []).map((g) => ({ ...g, conds: g.conds.slice() }));
    let removed = false;
    for (const g of groups) {
      const i = g.conds.findIndex((c) => condMatches(c, cond));
      if (i >= 0) {
        g.conds.splice(i, 1);
        removed = true;
        break;
      }
    }
    if (!removed) return;
    store.set({ advanced: { ...adv, groups: groups.filter((g) => g.conds.length > 0) } });
  }
  function restoreConditionByContent(cond, groupOp) {
    const adv = store.get().advanced;
    const groups = (adv.groups || []).map((g) => ({ ...g, conds: g.conds.slice() }));
    if (groups.length) groups[0].conds.push({ ...cond });
    else groups.push({ op: groupOp || "AND", conds: [{ ...cond }] });
    store.set({ advanced: { ...adv, groups } });
  }

  // Stable display order of pill keys, first-seen order — keeps a pill in place
  // when it transitions active <-> staged instead of jumping to the end. Pruned
  // each render to the keys currently present (active or staged).
  const orderList = [];
  function reconcileOrder(activeKeys, stagedKeys) {
    const present = new Set([...activeKeys, ...stagedKeys]);
    const kept = orderList.filter((k) => present.has(k));
    const keptSet = new Set(kept);
    for (const k of activeKeys) if (!keptSet.has(k)) { kept.push(k); keptSet.add(k); }
    for (const k of stagedKeys) if (!keptSet.has(k)) { kept.push(k); keptSet.add(k); }
    orderList.length = 0;
    orderList.push(...kept);
  }

  function render() {
    // R5-A #9: FILTER pills derive from `s` = the APPLIED snapshot (getState),
    // so a filter edited in the popup shows no pill until Search commits it. PIN
    // pills instead derive from `live` = the pending store, so picking a player
    // from the results search drops its pill in immediately and a pin ×/+ soft-
    // delete stays pending — both already-approved carve-outs (decision 50/47g).
    const s = getState();
    const live = store.get();
    const pills = []; // { key, label, remove(), restore(), inert?, pinned?, title? }

    // "Current team" mode (owner decision 46): one removable pill per team,
    // prefixed "Team:" to distinguish it from the "Historic team" (Ever played
    // for) pill below.
    for (const t of s.teams || []) {
      pills.push({
        key: `team:${t}`,
        label: `Team: ${t}`,
        remove: () => store.set({ teams: store.get().teams.filter((x) => x !== t) }),
        restore: () => {
          const cur = store.get().teams || [];
          if (!cur.includes(t)) store.set({ teams: [...cur, t] });
        },
      });
    }

    // Profile pills are men-only (decision 21) — inert while viewing women,
    // so no pill even if a stale value somehow lingered in state.
    if (s.gender !== "female" && hasActiveProfileFilter(s.profile)) {
      const p = s.profile;
      const profilePill = (field, value) => ({
        key: `profile:${field}`,
        label: value,
        remove: () => store.set({ profile: { ...store.get().profile, [field]: null } }),
        restore: () => store.set({ profile: { ...store.get().profile, [field]: value } }),
      });
      if (p.roleGroup) pills.push(profilePill("roleGroup", p.roleGroup));
      if (p.roleSub) pills.push(profilePill("roleSub", p.roleSub));
      if (p.battingHand) pills.push(profilePill("battingHand", p.battingHand));
      if (p.bowlingType) pills.push(profilePill("bowlingType", p.bowlingType));
      // The "Historic team" (Ever played for) pill is gone — owner 1B-2 removed
      // the Current/Historic distinction; profile.teams is no longer set by any
      // UI, so there is nothing to render here.
    }

    if (positionsFilterActive(s)) {
      const sorted = [...s.positions].sort((a, b) => a - b);
      const captured = [...s.positions];
      // Bowling-matchup mode (D4-R4): the filter narrows the batters faced,
      // not the bowler's own (nonexistent) batting position.
      const bowlingMatchup = s.discipline === "bowling" && matchupVsActive(s);
      const label = bowlingMatchup ? `To batters at ${sorted.join(", ")}` : `Batting at ${sorted.join(", ")}`;
      pills.push({ key: "positions", label, remove: () => store.set({ positions: [] }), restore: () => store.set({ positions: captured }) });
    }

    // R. Pos. (owner decision 46) — plain-mode filter on a player's most common
    // batting position within scope.
    if (regularPositionsFilterActive(s)) {
      const sorted = [...s.regularPositions].sort((a, b) => a - b);
      const captured = [...s.regularPositions];
      pills.push({ key: "regularPositions", label: `R. Pos. ${sorted.join(", ")}`, remove: () => store.set({ regularPositions: [] }), restore: () => store.set({ regularPositions: captured }) });
    }

    if (oppositionFilterActive(s)) {
      const captured = [...s.opposition];
      const label = s.opposition.length === 1 ? `vs ${s.opposition[0]}` : `vs ${s.opposition.length} opponents`;
      pills.push({ key: "opposition", label, remove: () => store.set({ opposition: [] }), restore: () => store.set({ opposition: captured }) });
    }

    // Event / Venue (Batch 1B): one removable pill per selected value, prefixed
    // so the honest scope reads plainly. Both are gender-scoped match filters.
    if (eventFilterActive(s)) {
      for (const e of s.event) {
        // Wave 6 pt2: reflect any season narrowing in the pill label ("Event:
        // IPL (2024, 2025)"); an event on "All seasons" reads plainly ("Event:
        // IPL"). Up to three seasons list out; beyond that a count keeps it short.
        const seasons = seasonsForEvent(s, e);
        const capturedSeasons = [...seasons];
        let label = `Event: ${e}`;
        if (seasons.length > 0) {
          label += seasons.length <= 3 ? ` (${seasons.join(", ")})` : ` (${seasons.length} seasons)`;
        }
        pills.push({
          key: `event:${e}`,
          label,
          // Removing the event also drops its season narrowing (an orphan key
          // would be inert, but the state stays clean + honest).
          remove: () => {
            const es = { ...(store.get().eventSeasons || {}) };
            delete es[e];
            store.set({ event: store.get().event.filter((x) => x !== e), eventSeasons: es });
          },
          restore: () => {
            const cur = store.get().event || [];
            const patch = {};
            if (!cur.includes(e)) patch.event = [...cur, e];
            if (capturedSeasons.length > 0) {
              patch.eventSeasons = { ...(store.get().eventSeasons || {}), [e]: capturedSeasons };
            }
            if (Object.keys(patch).length) store.set(patch);
          },
        });
      }
    }
    if (venueFilterActive(s)) {
      for (const v of s.venue) {
        pills.push({
          key: `venue:${v}`,
          label: `Venue: ${v}`,
          remove: () => store.set({ venue: store.get().venue.filter((x) => x !== v) }),
          restore: () => {
            const cur = store.get().venue || [];
            if (!cur.includes(v)) store.set({ venue: [...cur, v] });
          },
        });
      }
    }

    // Match-context filters (Wave 6): one removable pill per active filter. Each
    // multi-select collapses into a single pill listing its picked labels (they
    // are OR within the filter); ×/+ captures + restores the whole array (or the
    // excludeMethod boolean). These narrow the leaderboard query (buildQuery /
    // buildMatchupQuery); an active one is always "narrowing" in every view.
    const labelsFor = (vals, opts) => (vals || []).map((v) => opts.find((o) => o.value === v)?.label || v);
    if (resultFilterActive(s)) {
      const captured = [...s.result];
      pills.push({ key: "mc_result", label: `Result: ${labelsFor(s.result, RESULT_OPTIONS).join(", ")}`, remove: () => store.set({ result: [] }), restore: () => store.set({ result: captured }) });
    }
    if (tossResultFilterActive(s)) {
      const captured = [...s.tossResult];
      pills.push({ key: "mc_toss_result", label: labelsFor(s.tossResult, TOSS_RESULT_OPTIONS).join(", "), remove: () => store.set({ tossResult: [] }), restore: () => store.set({ tossResult: captured }) });
    }
    if (tossDecisionFilterActive(s)) {
      const captured = [...s.tossDecision];
      pills.push({ key: "mc_toss_decision", label: labelsFor(s.tossDecision, TOSS_DECISION_OPTIONS).join(", "), remove: () => store.set({ tossDecision: [] }), restore: () => store.set({ tossDecision: captured }) });
    }
    if (inningsOrderFilterActive(s)) {
      const captured = [...s.inningsOrder];
      pills.push({ key: "mc_innings_order", label: labelsFor(s.inningsOrder, INNINGS_ORDER_OPTIONS).join(", "), remove: () => store.set({ inningsOrder: [] }), restore: () => store.set({ inningsOrder: captured }) });
    }
    if (stageFilterActive(s)) {
      const captured = [...s.stage];
      const label = s.stage.length <= 2 ? `Stage: ${s.stage.join(", ")}` : `Stage: ${s.stage.length} stages`;
      pills.push({ key: "mc_stage", label, remove: () => store.set({ stage: [] }), restore: () => store.set({ stage: captured }) });
    }
    if (methodFilterActive(s)) {
      pills.push({ key: "mc_method", label: "Excl. D/L & method-decided", remove: () => store.set({ excludeMethod: false }), restore: () => store.set({ excludeMethod: true }) });
    }

    // Fielding SLICE conditions (fielding rebuild): one pill per active slice,
    // gated to PLAIN mode — the slice only bites the fielding_cte in buildQuery,
    // so under a matchup Vs bucket it narrows nothing and (per this file's rule:
    // an inert filter shows no pill) must not render. Each ×/+ acts on the LIVE
    // store's state.fielding list.
    if (!matchupVsActive(s)) {
      const fld = s.fielding || {};
      const setFld = (patch) => store.set({ fielding: { ...(store.get().fielding || {}), ...patch } });
      if (fieldingPositionActive(s)) {
        const captured = [...fld.positions];
        const sorted = [...fld.positions].sort((a, b) => a - b);
        pills.push({
          key: "fld_pos",
          label: `Dismissed pos: ${sorted.join(", ")}`,
          remove: () => setFld({ positions: [] }),
          restore: () => setFld({ positions: captured }),
        });
      }
      if (fieldingKindActive(s)) {
        const captured = [...fld.kinds];
        const labels = fld.kinds.map((k) => FIELDING_KIND_OPTIONS.find((o) => o.value === k)?.label || k);
        pills.push({
          key: "fld_kind",
          label: `Dismissal: ${labels.join(", ")}`,
          remove: () => setFld({ kinds: [] }),
          restore: () => setFld({ kinds: captured }),
        });
      }
      if (fieldingPhaseActive(s)) {
        const captured = [...fld.phases];
        const labels = fld.phases.map((p) => FIELDING_PHASE_OPTIONS.find((o) => o.value === p)?.label || p);
        pills.push({
          key: "fld_phase",
          label: `Fielding phase: ${labels.join(", ")}`,
          remove: () => setFld({ phases: [] }),
          restore: () => setFld({ phases: captured }),
        });
      }
    }

    // Free-text player-name filter (state.search) — written by omnisearch's
    // "Filter the table to names matching …" action in the results-toolbar
    // search box (an ILIKE substring). One removable "Name: X" pill.
    if (s.search && s.search.trim()) {
      const term = s.search.trim();
      pills.push({ key: "search", label: `Name: ${term}`, remove: () => store.set({ search: "" }), restore: () => store.set({ search: term }) });
    }

    // Stat conditions (decision 42): one pill per ACTIVE condition (metric +
    // valid value), reading the condition itself, from the APPLIED snapshot's
    // current-discipline block (R5-A #7/#9). Remove/restore act on the LIVE store
    // by CONTENT (removeConditionByContent above), so no index bookkeeping is
    // needed here.
    (s.advanced.groups || []).forEach((g) => {
      g.conds.forEach((c) => {
        if (!isConditionComplete(c)) return;
        // Stable key by CONTENT (not gi/ci — those re-index when a sibling
        // condition is removed, which would collide across active/staged).
        const condCopy = { ...c };
        const groupOp = g.op;
        pills.push({
          key: `cond:${c.metricKey}:${c.operator}:${c.v1}:${c.v2}`,
          label: conditionPillLabel(c, s),
          // R5-A #9: derived from APPLIED state; remove/restore act on the LIVE
          // store by CONTENT (see removeConditionByContent above). Soft-delete
          // stages the pill (red outline) and commits on Search.
          remove: () => removeConditionByContent(condCopy),
          restore: () => restoreConditionByContent(condCopy, groupOp),
        });
      });
    });

    // Pinned players get NO pill (owner 2026-07-23): the pin COLUMN in the table
    // is the single place to see and manage pins (click to pin/unpin, pinned
    // rows float to the top; a searched-in player IS a pin, so they float in
    // automatically). The redundant pin chip is gone. Pin FUNCTIONALITY is
    // untouched — state.pinnedPlayers, the float, and the "(no innings)" toast
    // (main.js reportPinCoverage) all remain; only the chip is removed.
    // `live` and `getNoInningsIds` are still accepted for signature stability.
    void live;
    void getNoInningsIds;

    // R5-A #9: merge ACTIVE pills (derived above) with STAGED (soft-deleted) ones.
    // STAGED wins over active: a FILTER pill derives from the APPLIED snapshot, so
    // after its × the filter is still in applied (unchanged until Search) and would
    // otherwise re-derive as active — the staged entry must keep showing its red-
    // outline undo instead. A PIN pill's × removes it from the live store, so it
    // isn't active anyway (staged-wins is a harmless no-op there). A restored pill
    // is deleted from `staged` (see the ×/+ handler), so it returns to active.
    const active = new Map(pills.map((p) => [p.key, p]));
    reconcileOrder([...active.keys()], [...staged.keys()]);

    const display = orderList
      .map((k) => {
        const st = staged.get(k);
        if (st) return { ...st, staged: true };
        const a = active.get(k);
        return a ? { ...a, staged: false } : null;
      })
      .filter(Boolean);

    if (display.length === 0) {
      container.innerHTML = "";
      return;
    }

    container.innerHTML = `<div class="pills-row">${display
      .map((p, i) => {
        const cls = `pill${p.inert ? " pill--inert" : ""}${p.pinned ? " pill--pinned" : ""}${p.staged ? " pill--staged" : ""}${p.noInnings ? " pill--no-innings" : ""}`;
        const btnCls = `pill__x${p.staged ? " pill__x--restore" : ""}`;
        const glyph = p.staged ? "&plus;" : "&times;";
        const aria = p.staged ? "Restore filter" : "Remove filter";
        return `<span class="${cls}"${p.title ? ` title="${esc(p.title)}"` : ""}>${esc(p.label)} <button type="button" class="${btnCls}" data-idx="${i}" aria-label="${aria}">${glyph}</button></span>`;
      })
      .join("")}</div>`;

    container.querySelectorAll(".pill__x").forEach((btn) => {
      btn.addEventListener("click", () => {
        const p = display[Number(btn.dataset.idx)];
        if (p.staged) {
          // + : restore the pill's effect to the pending set, un-stage it.
          staged.delete(p.key);
          p.restore();
        } else {
          // × : soft-delete — stage the captured descriptor (so it stays
          // visible), then remove its effect from the pending set.
          staged.set(p.key, { key: p.key, label: p.label, inert: p.inert, pinned: p.pinned, noInnings: p.noInnings, title: p.title, restore: p.restore });
          p.remove();
        }
        // Every pill's ×/+ (FILTER and PIN alike) is a PENDING edit: refresh
        // derived views + light/settle the Search button; the frozen table
        // never moves here — a staged removal only takes effect at the next
        // Search. (Owner ruling 2026-07-17: INSTANT applies ONLY to *picking* a
        // player from the results search — see main.js pinPlayer/onPinsChanged
        // — NOT to a pill's ×/+.)
        onChange();
      });
    });
  }

  render();

  // A4: drop every staged (soft-deleted) pill — called by main.js when a Search
  // or Clear commits, at which point the removals are permanent and the staged
  // pills must stop rendering.
  function clearStaged() {
    staged.clear();
  }

  return { render, clearStaged };
}
