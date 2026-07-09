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

import { metricsFor, getMetric } from "./metrics.js";
import { eligibleMetrics, effectiveNamespace } from "./state.js";

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

/** Groups (and conditions within) that are actually active, i.e. complete. */
export function activeGroups(advanced) {
  return (advanced.groups || [])
    .map((g) => ({ ...g, conds: g.conds.filter(isConditionComplete) }))
    .filter((g) => g.conds.length > 0);
}

export function activeConditionCount(advanced) {
  return activeGroups(advanced).reduce((n, g) => n + g.conds.length, 0);
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

    const groupHTML = (group, gi) => `
      <div class="advanced-group" data-gi="${gi}">
        <div class="advanced-group__head">
          <span class="advanced-group__label">Match</span>
          <div class="segmented segmented--small" data-role="group-op">
            <button type="button" class="segmented__btn ${group.op === "AND" ? "is-active" : ""}" data-value="AND">All</button>
            <button type="button" class="segmented__btn ${group.op === "OR" ? "is-active" : ""}" data-value="OR">Any</button>
          </div>
          <span class="advanced-group__label">of:</span>
          <button type="button" class="icon-btn" data-role="remove-group" title="Remove group">&times;</button>
        </div>
        <div class="advanced-conds">
          ${group.conds.map((c, ci) => conditionHTML(c, ci, metrics)).join("")}
        </div>
        <button type="button" class="text-btn" data-role="add-cond">+ Add condition</button>
      </div>`;

    const groupsHTML = advanced.groups
      .map((g, gi) => (gi > 0 ? topConnectorHTML(advanced.op) : "") + groupHTML(g, gi))
      .join("");

    container.innerHTML = `
      <div class="advanced-panel">
        ${groupsHTML}
        <button type="button" class="text-btn text-btn--add-group" data-role="add-group">+ Add group</button>
        <div class="advanced-actions">
          <button type="button" class="btn btn--primary" data-role="apply">Apply</button>
          <button type="button" class="btn btn--ghost" data-role="clear">Clear</button>
        </div>
      </div>`;

    wire();
  }

  function topConnectorHTML(op) {
    return `<div class="advanced-connector"><span class="advanced-connector__pill" data-role="top-op">${op}</span></div>`;
  }

  function conditionHTML(cond, ci, metrics) {
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
    return `
      <div class="advanced-cond" data-ci="${ci}">
        <select class="select" data-role="metric">
          <option value="">Metric…</option>
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
        <button type="button" class="icon-btn" data-role="remove-cond" title="Remove condition">&times;</button>
      </div>`;
  }

  function wire() {
    const state = store.get();
    const advanced = state.advanced;

    container.querySelectorAll('[data-role="top-op"]').forEach((el) => {
      el.addEventListener("click", () => {
        advanced.op = advanced.op === "AND" ? "OR" : "AND";
        store.set({ advanced: { ...advanced } });
        render();
      });
    });

    const addGroupBtn = container.querySelector('[data-role="add-group"]');
    if (addGroupBtn) {
      addGroupBtn.addEventListener("click", () => {
        advanced.groups.push(newGroup());
        store.set({ advanced: { ...advanced } });
        render();
      });
    }

    container.querySelectorAll(".advanced-group").forEach((groupEl) => {
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

      const removeGroupBtn = groupEl.querySelector('[data-role="remove-group"]');
      if (removeGroupBtn) {
        removeGroupBtn.addEventListener("click", () => {
          advanced.groups.splice(gi, 1);
          if (advanced.groups.length === 0) advanced.groups.push(newGroup());
          store.set({ advanced: { ...advanced } });
          render();
        });
      }

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

        const metricSel = condEl.querySelector('[data-role="metric"]');
        metricSel.addEventListener("change", () => {
          cond.metricKey = metricSel.value;
          store.set({ advanced: { ...advanced } });
        });

        const opSel = condEl.querySelector('[data-role="operator"]');
        opSel.addEventListener("change", () => {
          const wasBetween = cond.operator === "between";
          cond.operator = opSel.value;
          store.set({ advanced: { ...advanced } });
          if (wasBetween !== (cond.operator === "between")) render();
        });

        condEl.querySelectorAll('[data-role="v1"],[data-role="v2"]').forEach((input) => {
          input.addEventListener("input", () => {
            cond[input.dataset.role] = input.value;
            store.set({ advanced: { ...advanced } });
          });
        });

        const removeCondBtn = condEl.querySelector('[data-role="remove-cond"]');
        if (removeCondBtn) {
          removeCondBtn.addEventListener("click", () => {
            group.conds.splice(ci, 1);
            if (group.conds.length === 0) {
              if (advanced.groups.length > 1) advanced.groups.splice(gi, 1);
              else group.conds.push(newCondition());
            }
            store.set({ advanced: { ...advanced } });
            render();
          });
        }
      });
    });

    const applyBtn = container.querySelector('[data-role="apply"]');
    if (applyBtn) applyBtn.addEventListener("click", () => onChange());

    const clearBtn = container.querySelector('[data-role="clear"]');
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        store.set({ advanced: { op: "AND", groups: [newGroup()] } });
        render();
        onChange();
      });
    }
  }

  render();
  return { render };
}
