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
 * R4 Wave 4a (A2): `getState` now defaults to — and main.js passes — the LIVE
 * (pending) store, so a pending edit (popup filter, toolbar control, pin add,
 * pill ×) surfaces as a pill IMMEDIATELY, matching the other pending toolbar
 * controls. The table body still only moves on Search; the pills are a live
 * indicator of what the NEXT Search will apply.
 */
export function mountPills(container, store, onChange, onPinChange = onChange, getState = () => store.get()) {
  // R4 Wave 4a (A4): soft-delete-with-undo. A pill's × removes its effect from
  // the PENDING store (so the Search button lights, per A2) AND stages the pill
  // for display — it stays visible with a red outline and the × flipped to a +.
  // Clicking + re-adds the effect and returns the pill to normal. A staged pill
  // survives re-render (its effect is gone from state, so render() can't
  // re-derive it) via this Map, keyed by a stable pill key; each entry carries
  // the captured descriptor + a restore() closure. Cleared on the next Search /
  // Clear commit (clearStaged), at which point the removal is permanent.
  const staged = new Map();

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
    const s = getState();
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
    // valid value), reading the condition itself. Iterates the raw
    // state.advanced.groups (not advanced.js's activeGroups()) so gi/ci here
    // are the TRUE indices removeConditionAt() needs — activeGroups() filters
    // out incomplete rows first, which would shift indices whenever a blank
    // edit-row sits before a complete one.
    (s.advanced.groups || []).forEach((g, gi) => {
      g.conds.forEach((c, ci) => {
        if (!isConditionComplete(c)) return;
        // Stable key by CONTENT (not gi/ci — those re-index when a sibling
        // condition is removed, which would collide across active/staged).
        const condCopy = { ...c };
        const groupOp = g.op;
        pills.push({
          key: `cond:${c.metricKey}:${c.operator}:${c.v1}:${c.v2}`,
          label: conditionPillLabel(c, s),
          remove: () => removeConditionAt(store, gi, ci),
          // Undo: re-insert the captured condition into its group (append), or
          // recreate the group if it was collapsed when the last cond left it.
          restore: () => {
            const adv = store.get().advanced;
            const groups = (adv.groups || []).map((gr) => ({ ...gr, conds: [...gr.conds] }));
            if (groups[gi]) groups[gi].conds.push(condCopy);
            else groups.push({ op: groupOp, conds: [condCopy] });
            store.set({ advanced: { ...adv, groups } });
          },
        });
      });
    });

    // Pinned players (task 3b; R3 Wave 6 owner-decided leftover: pushed LAST
    // so they always render to the right of every filter pill above — a pin
    // ADDS a player to the result set rather than narrowing it, so it reads
    // differently and sits differently). `pinned: true` gets the distinct
    // accent-tint styling (.pill--pinned in styles.css) so it's visually
    // distinguishable from the neutral filter pills too, not just positioned
    // after them. Wave 4b (decision 47a): pins now apply in matchup ("Vs")
    // mode as well as plain mode (buildMatchupQuery exempts them through the
    // same shared helper as buildQuery), so the pill is LIVE in both — no
    // longer greyed/inert in Vs.
    for (const p of s.pinnedPlayers || []) {
      pills.push({
        key: `pin:${p.id}`,
        label: `+ ${p.name}`,
        pinned: true,
        remove: () =>
          store.set({ pinnedPlayers: (store.get().pinnedPlayers || []).filter((x) => x.id !== p.id) }),
        restore: () => {
          const cur = store.get().pinnedPlayers || [];
          if (!cur.some((x) => x.id === p.id)) store.set({ pinnedPlayers: [...cur, p] });
        },
      });
    }

    // A4: merge the ACTIVE pills (derived above from the pending state) with the
    // STAGED pills (soft-deleted — no longer in state, so not derived; kept in
    // the `staged` Map with their captured descriptor + restore). A key can't be
    // both (staging removes it from state); if one somehow reappears active
    // (e.g. the same team re-added via another control), the active one wins and
    // its stale staged entry is dropped.
    const active = new Map(pills.map((p) => [p.key, p]));
    for (const k of active.keys()) staged.delete(k);
    reconcileOrder([...active.keys()], [...staged.keys()]);

    const display = orderList
      .map((k) => {
        const a = active.get(k);
        if (a) return { ...a, staged: false };
        const st = staged.get(k);
        return st ? { ...st, staged: true } : null;
      })
      .filter(Boolean);

    if (display.length === 0) {
      container.innerHTML = "";
      return;
    }

    container.innerHTML = `<div class="pills-row">${display
      .map((p, i) => {
        const cls = `pill${p.inert ? " pill--inert" : ""}${p.pinned ? " pill--pinned" : ""}${p.staged ? " pill--staged" : ""}`;
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
          staged.set(p.key, { key: p.key, label: p.label, inert: p.inert, pinned: p.pinned, title: p.title, restore: p.restore });
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
