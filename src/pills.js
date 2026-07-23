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

import { positionsFilterActive, regularPositionsFilterActive, oppositionFilterActive, eventFilterActive, venueFilterActive, hasActiveProfileFilter, matchupVsActive, effectiveNamespace } from "./state.js";
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
        pills.push({
          key: `event:${e}`,
          label: `Event: ${e}`,
          remove: () => store.set({ event: store.get().event.filter((x) => x !== e) }),
          restore: () => {
            const cur = store.get().event || [];
            if (!cur.includes(e)) store.set({ event: [...cur, e] });
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
