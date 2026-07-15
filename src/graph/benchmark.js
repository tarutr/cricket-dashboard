// src/graph/benchmark.js
//
// Data layer for the Graph Builder's BENCHMARK chart (B8b, decision 44e): one
// ANCHOR player vs the best of the rest, one row per selected metric, grouped
// under kind-based category headers. See src/graph/benchmarkChart.js for the
// DOM renderer this feeds.
//
// ── No new SQL grammar (hard rule) ──────────────────────────────────────────
// fetchBenchmarkPool() reuses src/table.js's exported buildQuery() UNCHANGED —
// the exact "wrap idiom" charts.js's fetchWindowMetric()/dumbbell.js's
// fetchDumbbellSide() already use elsewhere in this codebase: clone the live
// filter state, run buildQuery(), take the SQL as-is. The one difference from
// those two: this query is never wrapped in an outer `WHERE id IN (...)` —
// the benchmark's whole point is the FULL filtered pool (every player who
// qualifies under the current scope), not just the checked roster. That pool
// is otherwise identical to what the Compare Stats table itself would show,
// gate-free since decision 44c (no base min-innings HAVING).
//
// JUDGMENT CALL — matchup ("Vs") mode is deliberately ignored here, exactly
// like every OTHER non-Dumbbell chart type in this file already does. Every
// metric this module offers comes from eligibleMetrics(discipline, formats)
// — the PLAIN batting/bowling namespace — never matchup_batting/
// matchup_bowling. buildQuery() auto-dispatches into buildMatchupQuery()
// whenever state.js's matchupVsActive(state) is true, which would look up
// these plain-namespace keys under the WRONG namespace (matchup_batting/
// matchup_bowling) — some keys collide harmlessly (e.g. "average",
// "strike_rate" exist in both with the same shape), but others don't exist
// there at all (e.g. bowling's "maidens") and would silently vanish from the
// aggregate with no error. Rather than let that happen, fetchBenchmarkPool()
// always forces `matchupVs: null` on the state it hands to buildQuery() —
// same effective behavior as charts.js's fetchSelectedPlayerMetrics(), which
// queries the plain `batting`/`bowling` view directly and never even looks at
// matchupVs. This means a Benchmark chart is scoped to the plain filter bar
// scope even if the Compare Stats table happens to be in Vs mode when the
// user switches to this chart type — flagged for owner review since it's a
// deviation from "every other filter carries over unchanged" (though so is
// Dumbbell's OWN gender/discipline gate, for the same underlying reason: this
// chart's vocabulary doesn't exist in the matchup namespace).
//
// ── Sample floors — REMOVED (R3 Wave 5 polish, owner decision) ─────────────
// table.js no longer exports SAMPLE_FLOORS/sampleFloorFor (the whole
// min-sample-floor/muting mechanism was removed there): every value in the
// pool now renders and ranks un-greyed, however thin its backing sample.
// Direct consequence, surfaced to the owner: computeBenchmarkRows()'s
// "best other" can now legitimately be a tiny-sample outlier — e.g. a player
// with one innings and a freak 250.00 strike rate can beat the real
// contenders and be named #1, where the old floor would have excluded them
// from the "others" ranking pool. This module still has its own §8.1
// hasMetricData() gate (NULL/0 rate values are excluded as genuine no-data,
// per the global rule) — that gate is unrelated to floors and stays exactly
// as it was.
// benchmarkFloorNotes() is kept as a stub (below) rather than deleted:
// graph.js imports and calls it directly (outside this wave's file
// ownership) for the paper card's footer text — returning `[]` unconditionally
// means that footer simply never mentions a floor again, which is the
// correct honest behavior now that none exist (SPEC §8: state only filters
// actually applied).

import { hasMetricData } from "../metrics.js";
import { eligibleMetrics } from "../state.js";
import { buildQuery } from "../table.js";
import { query } from "../db.js";

// ── Category headers (task brief: "group by the metric `kind` field") ──────
// Structural rule, applied literally: exactly 3 possible headers, one per
// `kind` value this chart ever shows (peaks/str-format metrics are excluded
// by benchmarkEligibleMetrics below, so "peak" never appears here).
//
// JUDGMENT CALL / FLAGGED CONTRADICTION: the task brief's own "CONTROLS"
// section lists the batting default set as "runs, fours, sixes (Volume) /
// strike_rate, boundary_pct, dot_pct (Tempo) / average, balls_per_dismissal
// (Reliability)" — a 4th label, "Reliability", for average/
// balls_per_dismissal. But both of those are `kind: "rate"` in metrics.js,
// same as strike_rate — under the strict "group by kind" structural rule
// stated earlier in the same brief ("Volume=totals, Tempo=rates,
// Consistency=percents — group by the metric `kind` field"), they belong in
// the SAME "Tempo" section as strike_rate, not a separate 4th header, and
// boundary_pct/dot_pct (kind: "percent") belong under "Consistency", not
// "Tempo". Resolved in favor of the strict structural rule (stated first, as
// "THE CHART"'s core mechanic, and unambiguous), since honoring the
// parenthetical would require either a 4th ad hoc header (breaking "group by
// kind") or hand-picking which rate metrics count as "Reliability" vs
// "Tempo" with no rule to draw the line. The SET of default metrics is
// unchanged from the brief either way — only which of 3 (not 4) headers each
// one renders under. Flagged for owner sign-off.
export const BENCHMARK_KIND_ORDER = ["total", "rate", "percent"];
export const BENCHMARK_KIND_LABELS = { total: "Volume", rate: "Tempo", percent: "Consistency" };

/**
 * Metrics eligible for the Benchmark chart's picker: `eligibleMetrics()`
 * (phase-gated per the live format selection, same as every other picker),
 * restricted to kinds this chart can meaningfully draw a "dominance bar" for
 * (total/rate/percent — "peak" metrics like High Score/BBI are single-
 * innings extremes, not a season-long aggregate to rank a whole pool by, and
 * BBI's format is a display string with no numeric ratio at all), AND
 * `higherIsBetter !== null` — a neutral counting stat (Matches, Innings) has
 * no "better/worse" direction, so calling one player "#1" on it would be
 * dishonest framing for a chart whose entire premise is "leads" vs "beaten".
 * Every metric in the brief's own default sets satisfies this.
 */
export function benchmarkEligibleMetrics(discipline, formats) {
  return eligibleMetrics(discipline, formats).filter(
    (m) => (m.kind === "total" || m.kind === "rate" || m.kind === "percent") && m.higherIsBetter !== null && m.format !== "str"
  );
}

// Default selected metrics (task brief, batting: 8 metrics / bowling: 6 —
// see bowling note below). Verified against metrics.js at authoring time:
// every key below exists under its discipline.
const DEFAULT_KEYS = {
  batting: ["runs", "fours", "sixes", "strike_rate", "boundary_pct", "dot_pct", "average", "balls_per_dismissal"],
  // JUDGMENT CALL: the brief's bowling line ("wickets, maidens / economy,
  // strike_rate / dot_pct equivalents") names dot_pct alone as the vague
  // "dot_pct equivalents" for the Consistency (percent) group. Bowling's own
  // `kind: "percent"` metrics are exactly two — dot_pct and
  // boundary_pct_conceded — the structural mirror of batting's own two
  // percent defaults (boundary_pct, dot_pct). Both are included for that
  // 2-Volume/2-Tempo/2-Consistency symmetry with batting's 3/3/2 shape.
  bowling: ["wickets", "maidens", "economy", "strike_rate", "dot_pct", "boundary_pct_conceded"],
};

/** Default metric-key selection for `discipline`, filtered to whatever's
 * actually eligible right now (defensive — every default key above is a
 * plain, non-phase-gated metric, so this is normally a no-op filter). */
export function defaultBenchmarkMetricKeys(discipline) {
  const eligible = new Set(benchmarkEligibleMetrics(discipline, []).map((m) => m.key));
  // formats:[] would wrongly exclude nothing here since none of the defaults
  // are phase metrics; pass through eligibleMetrics with an empty formats
  // array only to build the existence-check set, never to gate on formats —
  // callers should re-validate against the LIVE formats via
  // benchmarkEligibleMetrics(discipline, state.formats) themselves (graph.js
  // does, in its renderMetricControls() pruning pass).
  return (DEFAULT_KEYS[discipline] || []).filter((k) => eligible.has(k));
}

/**
 * Run the Benchmark chart's ONE pool query: table.js's buildQuery(), for the
 * given metric keys, over the FULL filtered pool (never restricted to the
 * checked roster — see file header). `matchupVs` is force-cleared (see file
 * header's judgment call).
 * @returns {Promise<Array<object>>} pool rows: {id, name, [key]}
 */
export async function fetchBenchmarkPool(state, metricKeys) {
  const poolState = { ...state, matchupVs: null };
  const { sql } = buildQuery(poolState, metricKeys);
  const { rows } = await query(sql);
  return rows;
}

/**
 * Group an ordered metric list into kind-based sections, in
 * Volume -> Tempo -> Consistency order, omitting empty sections. Metrics
 * keep their input relative order within a section.
 */
export function groupMetricsByKind(metrics) {
  return BENCHMARK_KIND_ORDER.map((kind) => ({
    kind,
    label: BENCHMARK_KIND_LABELS[kind],
    metrics: metrics.filter((m) => m.kind === kind),
  })).filter((g) => g.metrics.length > 0);
}

/**
 * Sample-floor footer notes — REMOVED (R3 Wave 5 polish): there are no more
 * floors to report, so this always returns `[]` now. Kept as a stub (not
 * deleted) purely because graph.js imports and calls it directly for the
 * paper card's footer text and is outside this wave's file ownership;
 * graph.js's own call site already treats an empty array as "say nothing
 * about floors", so this is a correct, no-code-elsewhere-touched no-op.
 */
export function benchmarkFloorNotes(_metrics) {
  return [];
}

/**
 * Compute one benchmark row per metric (in the SAME order as `metrics`),
 * against `anchorId`, from the pool `fetchBenchmarkPool()` returned. Pure
 * function, no DOM/query — this is what the verification harness exercises
 * directly.
 *
 * §8.1 hasMetricData applies to EVERY row (anchor included) before anything
 * else: a player (anchor or other) with no data for a metric is out of that
 * metric's ranking entirely.
 *
 * Sample floors — REMOVED (R3 Wave 5 polish, owner decision): every row with
 * real data (hasMetricData) is now a full ranking/"best other" candidate,
 * however thin its backing sample. FLAGGED CONSEQUENCE: `bestOther` can now
 * legitimately be a tiny-sample outlier (e.g. one-innings, freak-value
 * players) rather than a genuine contender — surfaced here since it changes
 * what "best other" can mean, not silently absorbed.
 *
 * @param {Array<object>} pool fetchBenchmarkPool()'s rows
 * @param {Array<object>} metrics metrics.js metric objects (benchmarkEligibleMetrics-filtered)
 * @param {string} anchorId
 * @returns {Array<object>} one descriptor per metric — see inline shape below
 */
export function computeBenchmarkRows(pool, metrics, anchorId) {
  return metrics.map((metric) => {
    const key = metric.key;

    // §8.1, universal — anchor included.
    const eligible = pool.filter((r) => hasMetricData(metric, r[key]));
    const anchorRow = eligible.find((r) => r.id === anchorId);

    if (!anchorRow) {
      return { metric, noAnchorData: true };
    }

    const anchorValue = Number(anchorRow[key]);

    const others = eligible.filter((r) => r.id !== anchorId);

    const dir = metric.higherIsBetter; // boolean, never null (pre-filtered by benchmarkEligibleMetrics)
    const rankPool = [anchorRow, ...others].sort((a, b) => {
      const va = Number(a[key]);
      const vb = Number(b[key]);
      return dir ? vb - va : va - vb; // best-first
    });
    const anchorRank = rankPool.findIndex((r) => r.id === anchorId) + 1;
    const poolSize = rankPool.length;

    let bestOther = null;
    if (others.length) {
      bestOther = others.slice().sort((a, b) => {
        const va = Number(a[key]);
        const vb = Number(b[key]);
        return dir ? vb - va : va - vb;
      })[0];
    }

    let ratioPct = null;
    let anchorLeads = true;
    if (bestOther) {
      const bestVal = Number(bestOther[key]);
      anchorLeads = dir ? anchorValue >= bestVal : anchorValue <= bestVal;
      // JUDGMENT CALL — "dominance ratio", direction-normalized: for a
      // higher-is-better metric this is the brief's literal
      // bestOther/anchor formula (verified against the Karanbir/Waseem
      // fixture: 1978/2454 = 80.6%). For a LOWER-is-better metric (economy,
      // batting dot%, …) the brief's literal wording is ambiguous — a raw
      // bestOther/anchor ratio there would read >100% even when the anchor
      // LEADS (e.g. anchor economy 4.0 vs a worse best-other of 5.0 ->
      // 5.0/4.0 = 125%), contradicting "the bar runs to <=100% when the
      // anchor leads". Inverting to anchor/bestOther for higherIsBetter:false
      // keeps that invariant true in both directions (ratio <= 100% whenever
      // anchorLeads, > 100% whenever beaten) and reduces to the literal
      // formula exactly when higherIsBetter is true. Flagged for owner
      // review — this is a charting-math judgment call, not assumed cricket
      // semantics.
      if (anchorValue === 0) {
        // Divide-by-zero guard: only reachable for a "total" kind metric
        // (zeroIsData true, so 0 is real data) where the anchor has a
        // genuine zero (e.g. 0 sixes) and someone else has more — every
        // total-kind metric in this catalogue is higherIsBetter:true, so
        // this is always the "anchor beaten by an infinite ratio" case, not
        // a leading one. Rendered with ratioPct null; the chart shows raw
        // values instead of a percentage (see benchmarkChart.js).
        ratioPct = null;
      } else {
        ratioPct = dir ? (bestVal / anchorValue) * 100 : (anchorValue / bestVal) * 100;
      }
    }

    return {
      metric,
      noAnchorData: false,
      anchorValue,
      anchorRank,
      poolSize,
      bestOther: bestOther ? { id: bestOther.id, name: bestOther.name, value: Number(bestOther[key]) } : null,
      ratioPct,
      anchorLeads,
    };
  });
}
