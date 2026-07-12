// src/advanced.js
//
// Advanced filters (SPEC §5.2): AND/OR condition builder. Groups of conditions
// (metric select from metricsFor(discipline), operator >= <= = between, value(s))
// combinable with AND/OR at both the group level and the top level.
//
// Conditions apply to the COMPUTED metric values (HAVING-level) — src/table.js
// turns each condition into a HAVING predicate using the metric's sqlExpression,
// and (per §8.1) ANDs in a hasMetricData-equivalent guard for rate/ratio metrics
// so no-data players never satisfy a condition by accident (NULL already fails
// naturally in SQL; zeroIsData:false metrics need an explicit != 0 guard since
// "avg = 0" would otherwise be a false positive if a zero denominator NULL were
// coalesced anywhere — it never is, but a raw `0` numerator on a data row must
// also be excluded, matching the client-side hasMetricData contract).
//
// B2R wave 2 (decision 42): the group-level "remove whole group" × beside
// "Match All/Any of:" is gone — a group already disappears on its own once its
// last condition is removed (see removeConditionAt below), so that button was
// a redundant second way to do the same thing. Each condition row now has
// exactly one remove button, pinned to the row's end via a dedicated
// .advanced-cond__row wrapper (previously it could wrap onto its own line at
// narrow widths, reading as a stray floating ×). The panel's own inline
// Apply/Clear buttons are gone too — the drawer's footer ("Apply and show
// results" / "Clear all") are the only actions now; Apply validates first
// (see validate() below) and blocks with an inline per-row message rather than
// silently dropping a half-filled condition.

import { metricsFor, getMetric } from "./metrics.js";
import { eligibleMetrics, effectiveNamespace } from "./state.js";
import { mountOpposition } from "./drawerInnings.js";

const OPERATORS = [
  { key: "gte", label: "at least (≥)" },
  { key: "lte", label: "at most (≤)" },
  { key: "eq", label: "equals (=)" },
  { key: "between", label: "between" },
];

function newCondition() {
  return { metricKey: "", operator: "gte", v1: "", v2: "" };
}
function newGroup() {
  return { op: "AND", conds: [newCondition()] };
}

/** Ensure state.advanced has at least one group with one condition to edit. */
function ensureAdvanced(store) {
  const state = store.get();
  if (!state.advanced || !state.advanced.groups || state.advanced.groups.length === 0) {
    store.set({ advanced: { op: state.advanced?.op ?? "AND", groups: [newGroup()] } });
  }
}

/** Conditions that are fully filled in (metric chosen + numeric value(s) valid). */
export function isConditionComplete(cond) {
  if (!cond.metricKey) return false;
  if (cond.v1 === "" || cond.v1 === null || cond.v1 === undefined || Number.isNaN(parseFloat(cond.v1))) return false;
  if (cond.operator === "between") {
    if (cond.v2 === "" || cond.v2 === null || cond.v2 === undefined || Number.isNaN(parseFloat(cond.v2))) return false;
  }
  return true;
}

/** decision 42 validation rule: a metric was picked but the value is missing
 * or invalid. A fully blank default row (no metric picked either) is not an
 * error — it's ignored harmlessly, same as before. */
function conditionHasError(cond) {
  return Boolean(cond.metricKey) && !isConditionComplete(cond);
}

/** Groups (and conditions within) that are actually active, i.e. complete. */
export function activeGroups(advanced) {
  return (advanced.groups || [])
    .map((g) => ({ ...g, conds: g.conds.filter(isConditionComplete) }))
    .filter((g) => g.conds.length > 0);
}

export function activeConditionCount(advanced) {
  return activeGroups(advanced).reduce((n, g) => n + g.conds.length, 0);
}

/**
 * Remove condition `ci` from group `gi`, collapsing the group if it becomes
 * empty (deleting it unless it's the sole remaining group, in which case a
 * fresh blank row takes its place). Exported so pills.js's per-condition ×
 * (decision 42, named pills) can remove the exact same way this panel's own
 * remove button does — one shared code path, so the two can never diverge.
 */
export function removeConditionAt(store, gi, ci) {
  const advanced = store.get().advanced;
  const groups = advanced.groups.map((g, i) => (i === gi ? { ...g, conds: [...g.conds] } : g));
  const group = groups[gi];
  if (!group) return;
  group.conds.splice(ci, 1);
  if (group.conds.length === 0) {
    if (groups.length > 1) groups.splice(gi, 1);
    else group.conds.push(newCondition());
  }
  store.set({ advanced: { ...advanced, groups } });
}

function opWord(op) {
  return { gte: "at least", lte: "at most", eq: "equal to", between: "between" }[op] ?? op;
}

function condPhrase(cond, discipline) {
  const metric = metricsFor(discipline).find((m) => m.key === cond.metricKey);
  const label = metric ? metric.label : cond.metricKey;
  if (cond.operator === "between") return `${label} between ${cond.v1} and ${cond.v2}`;
  return `${label} ${opWord(cond.operator)} ${cond.v1}`;
}

/** Plain-English clause for the advanced filters, honest about what's active. */
export function describeAdvanced(state) {
  const groups = activeGroups(state.advanced);
  if (groups.length === 0) return "";
  const multi = groups.length > 1;
  const parts = groups.map((g) => {
    const joiner = g.op === "OR" ? " or " : " and ";
    const inner = g.conds.map((c) => condPhrase(c, state.discipline)).join(joiner);
    return multi && g.conds.length > 1 ? `(${inner})` : inner;
  });
  return parts.join(state.advanced.op === "OR" ? " or " : " and ");
}

/**
 * Mount the advanced-filters panel (collapsed by default — caller controls the
 * `hidden` attribute of the surrounding <details>/toggle). Renders into `container`.
 */
export function mountAdvanced(container, store, onChange) {
  // Batch 3 fix 2: a structural fingerprint of "everything render() needs to
  // rebuild the DOM for" — group/condition shape (count, metric, operator)
  // plus the eligible-metrics vocabulary (mode/phase gating) — deliberately
  // EXCLUDING each condition's raw v1/v2 text. store.set() fires on every
  // keystroke in a value input (so the pill/badge stay live, per fix 1), and
  // previously render() unconditionally rebuilt the whole panel's innerHTML
  // on every one of those calls, destroying and recreating the very input
  // the user was typing into — killing focus and the caret mid-word. Typing a
  // value never changes this key, so render() below can skip the rebuild
  // whenever it's unchanged; anything that DOES change the key (add/remove a
  // condition, pick a metric/operator, switch discipline/format/Vs) still
  // rebuilds normally, focus or not.
  let lastRenderKey = null;

  // decision 42 inline validation: true once an Apply click has found at
  // least one row with a metric but no value. Conditions are re-evaluated
  // live off the current store (not a snapshot), so a row's error clears the
  // moment its value becomes valid again — see the v1/v2 input handler below,
  // which patches that one row's DOM directly rather than waiting for a full
  // (focus-destroying) rebuild.
  let showErrors = false;

  // ── Opposition-as-condition (F1b) ──────────────────────────────────────────
  // "Against opposition" is one selectable condition TYPE in the same +Add
  // list as the numeric metrics, but its value lives in state.opposition (NOT
  // state.advanced), so buildScopeClauses is completely untouched. There is at
  // most ONE opposition row; it's a SINGLETON rendered OUTSIDE the AND/OR
  // numeric groups (opposition is a pre-aggregation WHERE filter, not a HAVING
  // that participates in the groups' All/Any logic). Picking "Against
  // opposition" in a numeric row's type dropdown converts that row into this
  // singleton; the singleton's own type dropdown can morph it back to numeric.
  const OPP_KEY = "__opposition__"; // sentinel type value; never stored in state.advanced
  let oppRowVisible = false;
  let sessionAddedOpp = false; // user explicitly added the opposition row this popup session

  // Stable skeleton, built ONCE: the singleton opposition row + a numeric
  // sub-area that render() rebuilds. Keeping the opposition control OUTSIDE the
  // rebuilt area is what lets its team-dropdown (option cache, wiring, portal)
  // survive every numeric rebuild.
  container.innerHTML = `
    <div class="advanced-panel">
      <div class="advanced-cond advanced-cond--opp" data-role="adv-opp-row" hidden>
        <div class="advanced-cond__row">
          <div class="advanced-cond__fields">
            <select class="select advanced-cond__type" data-role="opp-type" aria-label="Condition type"></select>
            <div class="advanced-cond__opp-value" data-role="opp-value-host"></div>
          </div>
          <button type="button" class="icon-btn advanced-cond__remove" data-role="opp-remove" title="Remove condition">&times;</button>
        </div>
      </div>
      <div class="advanced-numeric" data-role="adv-numeric"></div>
    </div>`;

  const oppWrapEl = container.querySelector('[data-role="adv-opp-row"]');
  const oppTypeEl = container.querySelector('[data-role="opp-type"]');
  const oppValueHostEl = container.querySelector('[data-role="opp-value-host"]');
  const oppRemoveEl = container.querySelector('[data-role="opp-remove"]');
  const numericEl = container.querySelector('[data-role="adv-numeric"]');

  // The opposition control (reads/writes state.opposition, international-only
  // gating, option fetching) is the existing drawerInnings control, embedded
  // here so its own label is suppressed (the type dropdown already names it).
  const oppositionController = mountOpposition(oppValueHostEl, store, onChange, { embedded: true });

  function structuralKey(state, metrics) {
    const advanced = state.advanced;
    const groupsShape = (advanced.groups || [])
      .map((g) => `${g.op}:${g.conds.map((c) => `${c.metricKey}|${c.operator}`).join(",")}`)
      .join(";");
    // oppRowVisible is in the key so numeric rows' "Against opposition" option
    // re-renders enabled/disabled as the singleton row comes and goes.
    return JSON.stringify({ top: advanced.op, groups: groupsShape, vocab: metrics.map((m) => m.key), opp: oppRowVisible });
  }

  /** Reconcile the singleton opposition row from state — cheap, no focus
   * impact, so it runs on EVERY render() even when the numeric rebuild is
   * skipped. Also refreshes the type dropdown's metric vocabulary. */
  function reconcileOppRow(metrics) {
    // Visible iff opposition is actually set OR the user added the row this
    // session. An empty, never-filled row is INACTIVE (no pill, no filter) but
    // stays put for editing until removed via its × or a fresh popup open.
    oppRowVisible = (store.get().opposition || []).length > 0 || sessionAddedOpp;
    oppWrapEl.hidden = !oppRowVisible;
    oppTypeEl.innerHTML =
      `<option value="${OPP_KEY}" selected>Against opposition</option>` +
      metrics.map((m) => `<option value="${m.key}">${m.label}</option>`).join("");
    oppTypeEl.value = OPP_KEY;
    if (oppRowVisible) oppositionController.sync();
  }

  function groupHTML(group, gi, metrics) {
    return `
      <div class="advanced-group" data-gi="${gi}">
        <div class="advanced-group__head">
          <span class="advanced-group__label">Match</span>
          <div class="segmented segmented--small" data-role="group-op">
            <button type="button" class="segmented__btn ${group.op === "AND" ? "is-active" : ""}" data-value="AND">All</button>
            <button type="button" class="segmented__btn ${group.op === "OR" ? "is-active" : ""}" data-value="OR">Any</button>
          </div>
          <span class="advanced-group__label">of:</span>
        </div>
        <div class="advanced-conds">
          ${group.conds.map((c, ci) => conditionHTML(c, ci, gi, metrics)).join("")}
        </div>
        <button type="button" class="text-btn" data-role="add-cond">+ Add condition</button>
      </div>`;
  }

  function render() {
    ensureAdvanced(store);
    const state = store.get();
    const advanced = state.advanced;
    // Metrics eligible under the current format scope (SPEC §8.9) — e.g.
    // T20-phase metrics only when formats is exactly the T20 bucket — AND in
    // the ACTIVE mode's vocabulary: matchup_batting/matchup_bowling while a
    // "Vs" selection is active, so conditions are authored in the same
    // namespace the query will resolve them against (D4 R3/R4).
    const ns = effectiveNamespace(state);
    const metrics = eligibleMetrics(ns, state.formats);

    // Opposition row first (cheap; must run even when the numeric rebuild below
    // is skipped for focus preservation).
    reconcileOppRow(metrics);

    const key = structuralKey(state, metrics);
    if (key === lastRenderKey) {
      // Nothing structural changed since the last rebuild (e.g. a value-input
      // keystroke, or an unrelated control's sync()) — skip the rebuild so
      // focus/caret survive typing into a condition's value input.
      return;
    }
    lastRenderKey = key;

    const groupsHTML = advanced.groups
      .map((g, gi) => (gi > 0 ? topConnectorHTML(advanced.op) : "") + groupHTML(g, gi, metrics))
      .join("");

    numericEl.innerHTML = `${groupsHTML}<button type="button" class="text-btn text-btn--add-group" data-role="add-group">+ Add group</button>`;

    wire();
  }

  function topConnectorHTML(op) {
    return `<div class="advanced-connector"><span class="advanced-connector__pill" data-role="top-op">${op}</span></div>`;
  }

  function conditionHTML(cond, ci, gi, metrics) {
    // A condition authored in a DIFFERENT namespace (e.g. a matchup-only
    // metric while now viewing the plain table) won't be in `metrics` — render
    // its saved key as a disabled placeholder option instead of silently
    // losing the selection or crashing (state.js's pruneIneligibleState keeps
    // it around precisely so it survives a mode switch and can come back).
    const knownHere = cond.metricKey && metrics.some((m) => m.key === cond.metricKey);
    const unknownOptionHTML =
      cond.metricKey && !knownHere
        ? (() => {
            const m = getMetric(cond.metricKey);
            const label = m ? m.label : cond.metricKey;
            return `<option value="${cond.metricKey}" selected>${label} (not available in this view)</option>`;
          })()
        : "";
    const hasError = showErrors && conditionHasError(cond);
    return `
      <div class="advanced-cond ${hasError ? "advanced-cond--error" : ""}" data-ci="${ci}">
        <div class="advanced-cond__row">
          <div class="advanced-cond__fields">
            <select class="select" data-role="metric">
              <option value="">Metric…</option>
              <option value="${OPP_KEY}"${oppRowVisible ? " disabled" : ""}>Against opposition</option>
              ${unknownOptionHTML}
              ${metrics.map((m) => `<option value="${m.key}" ${cond.metricKey === m.key ? "selected" : ""}>${m.label}</option>`).join("")}
            </select>
            <select class="select" data-role="operator">
              ${OPERATORS.map((o) => `<option value="${o.key}" ${cond.operator === o.key ? "selected" : ""}>${o.label}</option>`).join("")}
            </select>
            ${
              cond.operator === "between"
                ? `<input type="number" class="input" data-role="v1" value="${cond.v1}" placeholder="min" />
                   <span class="advanced-cond__and">and</span>
                   <input type="number" class="input" data-role="v2" value="${cond.v2}" placeholder="max" />`
                : `<input type="number" class="input" data-role="v1" value="${cond.v1}" placeholder="value" />`
            }
          </div>
          <button type="button" class="icon-btn advanced-cond__remove" data-role="remove-cond" title="Remove condition">&times;</button>
        </div>
        ${hasError ? `<p class="advanced-cond__error" data-role="cond-error">Enter a value or remove this condition</p>` : ""}
      </div>`;
  }

  function wire() {
    const state = store.get();
    const advanced = state.advanced;

    numericEl.querySelectorAll('[data-role="top-op"]').forEach((el) => {
      el.addEventListener("click", () => {
        advanced.op = advanced.op === "AND" ? "OR" : "AND";
        store.set({ advanced: { ...advanced } });
        render();
      });
    });

    const addGroupBtn = numericEl.querySelector('[data-role="add-group"]');
    if (addGroupBtn) {
      addGroupBtn.addEventListener("click", () => {
        advanced.groups.push(newGroup());
        store.set({ advanced: { ...advanced } });
        render();
      });
    }

    numericEl.querySelectorAll(".advanced-group").forEach((groupEl) => {
      const gi = Number(groupEl.dataset.gi);
      const group = advanced.groups[gi];
      if (!group) return;

      groupEl.querySelectorAll('[data-role="group-op"] .segmented__btn').forEach((btn) => {
        btn.addEventListener("click", () => {
          group.op = btn.dataset.value;
          store.set({ advanced: { ...advanced } });
          render();
        });
      });

      const addCondBtn = groupEl.querySelector('[data-role="add-cond"]');
      if (addCondBtn) {
        addCondBtn.addEventListener("click", () => {
          group.conds.push(newCondition());
          store.set({ advanced: { ...advanced } });
          render();
        });
      }

      groupEl.querySelectorAll(".advanced-cond").forEach((condEl) => {
        const ci = Number(condEl.dataset.ci);
        const cond = group.conds[ci];
        if (!cond) return;

        // Batch 3 fix 1: metric/operator selects and value inputs must reach
        // onChange() like every other drawer control — otherwise closing the
        // drawer without hitting its own "Apply" leaves the table/graph
        // showing a scope the pills no longer describe (§8.4 honesty). Selects
        // fire onChange on "change" (a committed pick, one event per edit — no
        // per-keystroke requery risk since there's no keystroke). Value inputs
        // still update the store on every "input" keystroke (so the pill/badge
        // stay live and typing is never lost, see fix 2 below) but only fire
        // onChange on "change" (blur/Enter — the committed value), so a
        // half-typed number never triggers a graph re-query mid-keystroke.
        const metricSel = condEl.querySelector('[data-role="metric"]');
        metricSel.addEventListener("change", () => {
          if (metricSel.value === OPP_KEY) {
            // Convert this row into the singleton opposition row. Its value
            // lives in state.opposition, so drop this numeric placeholder from
            // state.advanced (removeConditionAt keeps ≥1 editable numeric row).
            removeConditionAt(store, gi, ci);
            sessionAddedOpp = true;
            lastRenderKey = null; // force the rebuild (OPP option now disabled elsewhere)
            render();
            onChange();
            return;
          }
          cond.metricKey = metricSel.value;
          store.set({ advanced: { ...advanced } });
          onChange();
        });

        const opSel = condEl.querySelector('[data-role="operator"]');
        opSel.addEventListener("change", () => {
          const wasBetween = cond.operator === "between";
          cond.operator = opSel.value;
          store.set({ advanced: { ...advanced } });
          if (wasBetween !== (cond.operator === "between")) render();
          onChange();
        });

        condEl.querySelectorAll('[data-role="v1"],[data-role="v2"]').forEach((input) => {
          input.addEventListener("input", () => {
            cond[input.dataset.role] = input.value;
            store.set({ advanced: { ...advanced } });
            // Live-clear this row's validation error the instant it's fixed
            // (decision 42) — without waiting for the next Apply click and
            // without a full render() rebuild, which would drop focus/caret
            // mid-keystroke (same reasoning as the structuralKey skip above).
            if (showErrors && !conditionHasError(cond)) {
              condEl.classList.remove("advanced-cond--error");
              const msg = condEl.querySelector('[data-role="cond-error"]');
              if (msg) msg.remove();
            }
          });
          input.addEventListener("change", () => {
            onChange();
          });
        });

        const removeCondBtn = condEl.querySelector('[data-role="remove-cond"]');
        if (removeCondBtn) {
          removeCondBtn.addEventListener("click", () => {
            removeConditionAt(store, gi, ci);
            render();
          });
        }
      });
    });
  }

  /**
   * decision 42: called by the drawer's footer "Apply and show results"
   * button before it does anything else. Returns true (and does nothing
   * visible) when every condition that has a metric picked also has a valid
   * value. Returns false — and forces a rebuild that shows an inline
   * "Enter a value or remove this condition" message on every offending row,
   * plus focuses the first one — when it doesn't, so a half-filled condition
   * is never silently dropped from the query.
   */
  function validate() {
    const state = store.get();
    const hasErrors = (state.advanced.groups || []).some((g) => g.conds.some(conditionHasError));
    showErrors = hasErrors;
    if (!hasErrors) return true;
    lastRenderKey = null; // force the rebuild below regardless of structural key
    render();
    const firstBad = numericEl.querySelector(".advanced-cond--error [data-role=\"v1\"]");
    if (firstBad) firstBad.focus();
    return false;
  }

  // ── Opposition row: remove (×) + type morph ────────────────────────────────
  // Removing clears state.opposition and drops the row (no pill, no filter).
  oppRemoveEl.addEventListener("click", () => {
    sessionAddedOpp = false;
    if ((store.get().opposition || []).length) store.set({ opposition: [] });
    lastRenderKey = null; // re-enable the "Against opposition" option in numeric rows
    render();
    onChange();
  });
  // Changing the type away from "Against opposition" morphs the singleton back
  // into a numeric condition of the chosen metric (opposition cleared).
  oppTypeEl.addEventListener("change", () => {
    if (oppTypeEl.value === OPP_KEY) return; // still opposition — nothing to do
    const chosen = oppTypeEl.value;
    sessionAddedOpp = false;
    if ((store.get().opposition || []).length) store.set({ opposition: [] });
    ensureAdvanced(store);
    const adv = store.get().advanced;
    const groups = adv.groups.map((g, i) =>
      i === 0 ? { ...g, conds: [...g.conds, { metricKey: chosen, operator: "gte", v1: "", v2: "" }] } : g
    );
    store.set({ advanced: { ...adv, groups } });
    lastRenderKey = null;
    render();
    onChange();
  });

  /** main.js/drawer.js call this after any filter change (while the popup is
   * visible): re-gate the metric vocabulary (§8.9 phase gating) and re-sync the
   * embedded opposition option list — the same refresh render() used to do when
   * this panel lived on the page. */
  function sync() {
    render();
  }

  /** Called by drawer.js when the popup OPENS: a never-filled opposition row
   * from a previous session shouldn't linger, so drop the session flag and let
   * reconcileOppRow re-derive visibility purely from state.opposition. */
  function onPopupShow() {
    sessionAddedOpp = false;
  }

  render();
  return { render, validate, sync, onPopupShow };
}
