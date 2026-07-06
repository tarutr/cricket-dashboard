// src/state.js
//
// Single state store for Compare Stats (SPEC §5, owner adjustments in the
// Phase 2 brief). Plain subscribe/notify — no framework.
//
// Shape:
// {
//   discipline: "batting" | "bowling",
//   gender: "female" | "male",
//   formats: string[]              // subset of FORMAT_BUCKETS keys, expanded to match_type values via FORMAT_MATCH_TYPES
//   dateFrom: "YYYY-MM" | null,
//   dateTo:   "YYYY-MM" | null,
//   teams: string[],                // batting_team/bowling_team values; [] = no team predicate (= all)
//   teamType: "international" | "club" | "both",
//   minInnings: number,
//   search: string,
//   sort: { key: string, dir: "asc" | "desc" },
//   columns: { batting: string[], bowling: string[] },   // visible metric keys, in order, per discipline
//   advanced: { op: "AND"|"OR", groups: [{ op: "AND"|"OR", conds: [{metricKey, operator, v1, v2}] }] },
// }
//
// `formats` stores owner-facing bucket keys (see FORMAT_BUCKETS below), not raw
// match_type values — "T20" here means the T20-bucket (T20 + IT20), matching the
// Phase 2 brief's owner decision that Cricsheet mislabels internationals.

import { metricsFor } from "./metrics.js";

/** The five format buckets surfaced in the UI, and the match_type values each expands to. */
export const FORMAT_BUCKETS = [
  { key: "T20", label: "T20", matchTypes: ["T20", "IT20"] },
  { key: "ODI", label: "ODI", matchTypes: ["ODI"] },
  { key: "ODM", label: "ODM", matchTypes: ["ODM"] },
  { key: "Test", label: "Test", matchTypes: ["Test"] },
  { key: "MDM", label: "MDM", matchTypes: ["MDM"] },
];

/** Expand the selected format bucket keys into the raw match_type values for SQL IN (...). */
export function expandFormats(formatKeys) {
  const set = new Set();
  for (const key of formatKeys) {
    const bucket = FORMAT_BUCKETS.find((b) => b.key === key);
    if (bucket) bucket.matchTypes.forEach((mt) => set.add(mt));
  }
  return [...set];
}

const DEFAULT_COLUMNS = {
  batting: ["matches", "innings", "runs", "average", "strike_rate", "high_score", "fours", "sixes"],
  bowling: ["matches", "innings", "wickets", "average", "economy", "strike_rate", "best"],
};

function monthsAgo(yyyymm, months) {
  const [y, m] = yyyymm.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - months);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Build the initial state. `maxMonth` ("YYYY-MM") comes from the manifest's
 * max match_date once known; until then dateFrom/dateTo are null and the
 * filter bar should treat that as "not yet bounded" (no date predicate).
 */
export function createInitialState(maxMonth) {
  const dateTo = maxMonth ?? null;
  const dateFrom = maxMonth ? monthsAgo(maxMonth, 36) : null;
  return {
    view: "table", // "table" | "graph" (SPEC §6 Graph Builder)
    discipline: "batting",
    gender: "female",
    formats: ["T20"],
    dateFrom,
    dateTo,
    teams: [],
    teamType: "international",
    minInnings: 10,
    search: "",
    sort: { key: "runs", dir: "desc" },
    columns: {
      batting: [...DEFAULT_COLUMNS.batting],
      bowling: [...DEFAULT_COLUMNS.bowling],
    },
    advanced: { op: "AND", groups: [] },
  };
}

export function defaultColumnsFor(discipline, formats) {
  if (discipline === "batting" && formats.length > 0 && formats.every((f) => f === "Test" || f === "MDM")) {
    // Owner exception: Test/MDM batting swaps strike_rate for balls_per_dismissal,
    // and leads with runs, average, balls_per_dismissal.
    return ["matches", "innings", "runs", "average", "balls_per_dismissal", "high_score", "fours", "sixes"];
  }
  return [...DEFAULT_COLUMNS[discipline]];
}

/**
 * True if a phase metric is currently eligible to be shown/offered (SPEC §8.9):
 * T20-range phase metrics only when formats is exactly ["T20"] (the T20+IT20
 * bucket); ODI-range phase metrics only when formats is a non-empty subset of
 * {"ODI", "ODM"}. Non-phase metrics are always eligible. Shared by the table's
 * column picker and the advanced-filter metric picker so both stay in sync.
 */
export function phaseMetricAllowed(metric, formats) {
  if (!metric.isPhaseMetric) return true;
  if (metric.isPhaseMetric === "t20") {
    return formats.length === 1 && formats[0] === "T20";
  }
  if (metric.isPhaseMetric === "odi") {
    if (formats.length === 0) return false;
    return formats.every((f) => f === "ODI" || f === "ODM");
  }
  return true;
}

/** All metrics eligible to appear as columns / advanced-filter fields right now. */
export function eligibleMetrics(discipline, formats) {
  return metricsFor(discipline).filter((m) => phaseMetricAllowed(m, formats));
}

/**
 * Remove columns AND advanced-filter conditions whose metric is no longer
 * eligible under the current discipline+formats (phase gating per §8.9, or a
 * discipline switch orphaning e.g. an "economy" condition while batting).
 * Silent-drop for both, so the scope description stays honest (§8.4): a
 * condition that can't be seen must never keep filtering players.
 * Returns true if anything changed.
 */
export function pruneIneligibleState(store) {
  const s = store.get();
  const allowed = new Set(eligibleMetrics(s.discipline, s.formats).map((m) => m.key));

  const cols = s.columns[s.discipline];
  const prunedCols = cols.filter((k) => allowed.has(k));
  const colsChanged = prunedCols.length !== cols.length;

  const groups = (s.advanced.groups || [])
    .map((g) => ({
      ...g,
      // keep incomplete conditions (blank metric) — they're inert edit rows
      conds: g.conds.filter((c) => !c.metricKey || allowed.has(c.metricKey)),
    }))
    .filter((g) => g.conds.length > 0);
  const condsChanged = JSON.stringify(groups) !== JSON.stringify(s.advanced.groups || []);

  if (!colsChanged && !condsChanged) return false;
  store.set({
    columns: colsChanged ? { ...s.columns, [s.discipline]: prunedCols } : s.columns,
    advanced: condsChanged ? { ...s.advanced, groups } : s.advanced,
  });
  return true;
}

/** GENDER_LABELS / TEAM_TYPE_LABELS used by describeScope() and the filter bar. */
export const GENDER_LABELS = { female: "Women's", male: "Men's" };
export const TEAM_TYPE_LABELS = { international: "international", club: "club", both: null };

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthLabel(yyyymm) {
  if (!yyyymm) return null;
  const [y, m] = yyyymm.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** Human label for the active format selection, e.g. "T20", "ODI + ODM", "T20 + Test". */
function formatsLabel(formats) {
  if (!formats || formats.length === 0) return null;
  return formats.join(" + ");
}

export function createStore(initial) {
  let state = initial;
  const listeners = new Set();

  function get() {
    return state;
  }

  function set(patch) {
    state = typeof patch === "function" ? patch(state) : { ...state, ...patch };
    notify();
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function notify() {
    for (const fn of listeners) fn(state);
  }

  /**
   * Honest plain-English scope sentence (§8.4) — only mentions filters that are
   * actually applied. e.g. "Women's T20s (international), Jul 2023 – Jul 2026, min 10 innings"
   */
  function describeScope() {
    const s = state;
    const parts = [];

    const genderWord = GENDER_LABELS[s.gender] ?? "";
    const fmtWord = formatsLabel(s.formats);
    let head = genderWord;
    if (fmtWord) head += (head ? " " : "") + fmtWord + "s";
    if (s.teamType !== "both") {
      head += (head ? " " : "") + `(${TEAM_TYPE_LABELS[s.teamType]})`;
    }
    if (head) parts.push(head.trim());

    const fromLbl = monthLabel(s.dateFrom);
    const toLbl = monthLabel(s.dateTo);
    if (fromLbl && toLbl) parts.push(`${fromLbl} – ${toLbl}`);
    else if (toLbl) parts.push(`through ${toLbl}`);
    else if (fromLbl) parts.push(`from ${fromLbl}`);

    if (s.teams && s.teams.length > 0) {
      parts.push(s.teams.length <= 3 ? s.teams.join(", ") : `${s.teams.length} teams`);
    }

    if (s.minInnings && s.minInnings > 1) {
      parts.push(`min ${s.minInnings} innings`);
    }

    if (s.search && s.search.trim()) {
      parts.push(`matching "${s.search.trim()}"`);
    }

    return parts.filter(Boolean).join(", ");
  }

  return { get, set, subscribe, describeScope };
}
