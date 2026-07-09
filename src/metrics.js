// src/metrics.js
//
// THE single metric catalogue for cricdb (SPEC §5.3). No metric may be defined
// anywhere else — both the Compare Stats table and the Graph Builder import this
// module and nothing else. If you need a new stat, add it here.
//
// ── Contract every entry must satisfy ─────────────────────────────────────────
// Each metric's `sqlExpression` is a SQL AGGREGATE expression that is
// interpolated verbatim into ONE grouped query per discipline:
//
//   batting:  SELECT batter_id, batter_name, <expr>, ...  FROM batting
//             WHERE <filters> GROUP BY batter_id, batter_name
//   bowling:  SELECT bowler_id, bowler_name, <expr>, ...  FROM bowling
//             WHERE <filters> GROUP BY bowler_id, bowler_name
//
// So every expression operates over the already-filtered per-innings rows of the
// `batting` / `bowling` views (one row per match-innings-player). The views are
// themselves aggregated from `deliveries` in the pipeline (export_parquet.py) and
// already bake in every cricket rule from SPEC §4.1:
//   • Super overs excluded, legal-ball definitions, bowler-credited wickets,
//     batter-dismissal set (retired out counts), byes/leg-byes excluded from
//     runs_conceded, maidens, phase column families, and — critically —
//     fours_hit/sixes_hit/fours_conceded/sixes_conceded already apply the
//     "runs_batter IN (4,6) AND is_not_boundary IS NOT TRUE" boundary rule.
//   Therefore boundary balls == fours_hit + sixes_hit (batting) and
//   fours_conceded + sixes_conceded (bowling). We must NOT re-derive it.
//
// EXCEPTION: metrics with `source: "player_matches"` (only `matches`) cannot be
// computed from the innings views (a player may appear in a match without batting
// or bowling). They are computed in a SEPARATE grouped query over the
// `player_matches` view with the SAME match-level filters, then joined on
// player_id by the table builder.
//
// ── Ratio safety (SPEC §5.3) ──────────────────────────────────────────────────
// EVERY denominator is wrapped in NULLIF(<d>, 0) so division by zero yields SQL
// NULL — never Infinity, never 0. Numerators carry a *1.0 (or *100.0 / *6.0)
// so integer division can never truncate. (View columns are DOUBLE today, but
// the *1.0 keeps the expressions correct regardless.)
//
// ── §8.1 "no data" semantics ──────────────────────────────────────────────────
// For rate/ratio metrics (`zeroIsData: false`), a value of 0 OR NULL means the
// player has no data for that metric and MUST be excluded from charts/rankings
// for it. For raw totals (`zeroIsData: true`), only NULL means no data — 0 is a
// legitimate value (0 runs, 0 wickets, 0 maidens). Use hasMetricData().
//
// ── Field reference ───────────────────────────────────────────────────────────
//   key/label/shortLabel — id + display names.  discipline, source (see above).
//   sqlExpression  — aggregate SQL over the filtered rows.
//   sortExpression — numeric aggregate to rank by when sqlExpression is a display
//                    string (only `best`/BBI); omitted otherwise.
//   higherIsBetter — true | false | null (null = neutral counting stat).
//   format         — "int" | "dec1" | "dec2" | "pct1" | "str".
//   isPhaseMetric  — null | "t20" | "odi".
//   zeroIsData     — true for raw totals; false for rates/ratios/averages.
//   minSampleComponent — aggregate SQL for the sample size backing the metric
//                        (e.g. "SUM(balls_faced)" for SR), for min-sample gates.

// ── Batting ───────────────────────────────────────────────────────────────────
const BATTING_METRICS = [
  {
    key: "matches",
    label: "Matches",
    shortLabel: "Mat",
    discipline: "batting",
    source: "player_matches",
    sqlExpression: "COUNT(DISTINCT match_id)",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "COUNT(DISTINCT match_id)",
  },
  {
    key: "innings",
    label: "Innings",
    shortLabel: "Inns",
    discipline: "batting",
    source: "innings",
    sqlExpression: "COUNT(*)",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "COUNT(*)",
  },
  {
    key: "runs",
    label: "Runs",
    shortLabel: "Runs",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(runs)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(runs)",
  },
  {
    key: "balls_faced",
    label: "Balls Faced",
    shortLabel: "BF",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(balls_faced)",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(balls_faced)",
  },
  {
    key: "high_score",
    label: "High Score",
    shortLabel: "HS",
    discipline: "batting",
    source: "innings",
    sqlExpression: "MAX(runs)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "COUNT(*)",
  },
  {
    key: "average",
    label: "Batting Average",
    shortLabel: "Avg",
    discipline: "batting",
    source: "innings",
    // Runs per dismissal. Not-outs (dismissed = 0) are excluded from the
    // denominator by construction — SUM(dismissed) counts only dismissals.
    sqlExpression: "SUM(runs) * 1.0 / NULLIF(SUM(dismissed), 0)",
    higherIsBetter: true, format: "dec2",
    isPhaseMetric: null, zeroIsData: false,
    minSampleComponent: "SUM(dismissed)",
  },
  {
    key: "strike_rate",
    label: "Strike Rate",
    shortLabel: "SR",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(runs) * 100.0 / NULLIF(SUM(balls_faced), 0)",
    higherIsBetter: true, format: "dec2",
    isPhaseMetric: null, zeroIsData: false,
    minSampleComponent: "SUM(balls_faced)",
  },
  {
    key: "balls_per_dismissal",
    label: "Balls per Dismissal",
    shortLabel: "BPD",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(balls_faced) * 1.0 / NULLIF(SUM(dismissed), 0)",
    higherIsBetter: true, format: "dec1",
    isPhaseMetric: null, zeroIsData: false,
    minSampleComponent: "SUM(dismissed)",
  },
  {
    key: "dot_pct",
    label: "Dot Ball %",
    shortLabel: "Dot%",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(dots) * 100.0 / NULLIF(SUM(balls_faced), 0)",
    higherIsBetter: false, // batting: fewer dots is better
    format: "pct1",
    isPhaseMetric: null,
    zeroIsData: false,
    minSampleComponent: "SUM(balls_faced)",
  },
  {
    key: "boundary_pct",
    label: "Boundary %",
    shortLabel: "Bdry%",
    discipline: "batting",
    source: "innings",
    // Boundary balls = fours_hit + sixes_hit (view already applies the
    // is_not_boundary rule). Share of balls faced that went for 4 or 6.
    sqlExpression: "(SUM(fours_hit) + SUM(sixes_hit)) * 100.0 / NULLIF(SUM(balls_faced), 0)",
    higherIsBetter: true, format: "pct1",
    isPhaseMetric: null, zeroIsData: false,
    minSampleComponent: "SUM(balls_faced)",
  },
  {
    key: "balls_per_boundary",
    label: "Balls per Boundary",
    shortLabel: "BPB",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(balls_faced) * 1.0 / NULLIF(SUM(fours_hit) + SUM(sixes_hit), 0)",
    higherIsBetter: false, // fewer balls between boundaries is better
    format: "dec1",
    isPhaseMetric: null,
    zeroIsData: false,
    minSampleComponent: "SUM(fours_hit) + SUM(sixes_hit)",
  },
  {
    key: "runs_per_innings",
    label: "Runs per Innings",
    shortLabel: "RPI",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(runs) * 1.0 / NULLIF(COUNT(*), 0)",
    higherIsBetter: true, format: "dec1",
    isPhaseMetric: null, zeroIsData: false,
    minSampleComponent: "COUNT(*)",
  },
  {
    key: "fours",
    label: "Fours",
    shortLabel: "4s",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(fours_hit)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(fours_hit)",
  },
  {
    key: "sixes",
    label: "Sixes",
    shortLabel: "6s",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(sixes_hit)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(sixes_hit)",
  },
  {
    key: "not_out_pct",
    label: "Not Out %",
    shortLabel: "NO%",
    discipline: "batting",
    source: "innings",
    // Share of innings in which the batter was not dismissed.
    sqlExpression: "SUM(CASE WHEN dismissed = 0 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0)",
    higherIsBetter: null, format: "pct1",
    isPhaseMetric: null, zeroIsData: false,
    minSampleComponent: "COUNT(*)",
  },
  // Faced-ball progression strike rates (D4): how a batter scores across the
  // first 10 balls faced in an innings, then balls 11–20, then 21+. These are
  // ball-count buckets (not over-based), so they are format-agnostic and NOT
  // phase-gated. The NULLIF sample gate excludes innings that never reached the
  // bucket, and zeroIsData:false means a batter with no balls in a bucket shows
  // "—" and is dropped from that ranking (§8.1).
  {
    key: "sr_first10",
    label: "Strike Rate (first 10 balls)",
    shortLabel: "SR 1-10",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(fb1_10_runs) * 100.0 / NULLIF(SUM(fb1_10_balls), 0)",
    higherIsBetter: true, format: "dec2",
    isPhaseMetric: null, zeroIsData: false,
    minSampleComponent: "SUM(fb1_10_balls)",
  },
  {
    key: "sr_11_20",
    label: "Strike Rate (balls 11–20)",
    shortLabel: "SR 11-20",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(fb11_20_runs) * 100.0 / NULLIF(SUM(fb11_20_balls), 0)",
    higherIsBetter: true, format: "dec2",
    isPhaseMetric: null, zeroIsData: false,
    minSampleComponent: "SUM(fb11_20_balls)",
  },
  {
    key: "sr_21plus",
    label: "Strike Rate (21+ balls)",
    shortLabel: "SR 21+",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(fb21p_runs) * 100.0 / NULLIF(SUM(fb21p_balls), 0)",
    higherIsBetter: true, format: "dec2",
    isPhaseMetric: null, zeroIsData: false,
    minSampleComponent: "SUM(fb21p_balls)",
  },
  // Phase strike rates — T20 ranges (pp 0–5, mid 6–14, death 15–19).
  {
    key: "pp_strike_rate",
    label: "Powerplay Strike Rate",
    shortLabel: "PP SR",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(pp_runs) * 100.0 / NULLIF(SUM(pp_balls), 0)",
    higherIsBetter: true, format: "dec2",
    isPhaseMetric: "t20", zeroIsData: false,
    minSampleComponent: "SUM(pp_balls)",
  },
  {
    key: "mid_strike_rate",
    label: "Middle Overs Strike Rate",
    shortLabel: "Mid SR",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(mid_runs) * 100.0 / NULLIF(SUM(mid_balls), 0)",
    higherIsBetter: true, format: "dec2",
    isPhaseMetric: "t20", zeroIsData: false,
    minSampleComponent: "SUM(mid_balls)",
  },
  {
    key: "death_strike_rate",
    label: "Death Overs Strike Rate",
    shortLabel: "Death SR",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(death_runs) * 100.0 / NULLIF(SUM(death_balls), 0)",
    higherIsBetter: true, format: "dec2",
    isPhaseMetric: "t20", zeroIsData: false,
    minSampleComponent: "SUM(death_balls)",
  },
  // Phase strike rates — ODI ranges (pp 0–9, mid 10–39, death 40–49).
  {
    key: "odi_pp_strike_rate",
    label: "ODI Powerplay Strike Rate",
    shortLabel: "ODI PP SR",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(odi_pp_runs) * 100.0 / NULLIF(SUM(odi_pp_balls), 0)",
    higherIsBetter: true, format: "dec2",
    isPhaseMetric: "odi", zeroIsData: false,
    minSampleComponent: "SUM(odi_pp_balls)",
  },
  {
    key: "odi_mid_strike_rate",
    label: "ODI Middle Overs Strike Rate",
    shortLabel: "ODI Mid SR",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(odi_mid_runs) * 100.0 / NULLIF(SUM(odi_mid_balls), 0)",
    higherIsBetter: true, format: "dec2",
    isPhaseMetric: "odi", zeroIsData: false,
    minSampleComponent: "SUM(odi_mid_balls)",
  },
  {
    key: "odi_death_strike_rate",
    label: "ODI Death Overs Strike Rate",
    shortLabel: "ODI Death SR",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(odi_death_runs) * 100.0 / NULLIF(SUM(odi_death_balls), 0)",
    higherIsBetter: true, format: "dec2",
    isPhaseMetric: "odi", zeroIsData: false,
    minSampleComponent: "SUM(odi_death_balls)",
  },
];

// Dismissal-kind breakdown (D4 Piece 3): how a batter's dismissals split by
// kind — one count column and one "% of dismissals" column per kind (owner
// choice: every kind separately, counts + %). The 12 kinds below are exactly
// the dismissal_kind values that carry dismissed = 1 in the data, so the
// counts partition SUM(dismissed) and the % columns share that denominator.
// Retired hurt / retired not out are NOT dismissals (dismissed = 0) and are
// excluded. `section: "dismissal"` groups these in the column picker.
// Exported for the player page's dismissal fingerprint (R2) — the UI derives
// its bar labels/keys from this table so the kind list stays defined once.
export const DISMISSAL_KINDS = [
  { kind: "caught", key: "out_caught", label: "Out Caught", short: "Ct" },
  { kind: "bowled", key: "out_bowled", label: "Out Bowled", short: "Bwd" },
  { kind: "lbw", key: "out_lbw", label: "Out LBW", short: "LBW" },
  { kind: "run out", key: "out_run_out", label: "Run Out", short: "RO" },
  { kind: "stumped", key: "out_stumped", label: "Out Stumped", short: "St" },
  { kind: "caught and bowled", key: "out_caught_and_bowled", label: "Out Caught & Bowled", short: "C&B" },
  { kind: "hit wicket", key: "out_hit_wicket", label: "Out Hit Wicket", short: "HW" },
  { kind: "retired out", key: "out_retired_out", label: "Retired Out", short: "Ret Out" },
  { kind: "obstructing the field", key: "out_obstructing_the_field", label: "Out Obstructing the Field", short: "Obs" },
  { kind: "handled the ball", key: "out_handled_the_ball", label: "Out Handled the Ball", short: "HB" },
  { kind: "timed out", key: "out_timed_out", label: "Timed Out", short: "TO" },
  { kind: "hit the ball twice", key: "out_hit_the_ball_twice", label: "Out Hit the Ball Twice", short: "2x" },
];
for (const d of DISMISSAL_KINDS) {
  const countExpr = `SUM(CASE WHEN dismissal_kind = '${d.kind}' THEN 1 ELSE 0 END)`;
  BATTING_METRICS.push({
    key: d.key,
    label: d.label,
    shortLabel: d.short,
    discipline: "batting",
    source: "innings",
    section: "dismissal",
    sqlExpression: countExpr,
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(dismissed)",
  });
  BATTING_METRICS.push({
    key: `${d.key}_pct`,
    label: `${d.label} %`,
    shortLabel: `${d.short} %`,
    discipline: "batting",
    source: "innings",
    section: "dismissal",
    sqlExpression: `${countExpr} * 100.0 / NULLIF(SUM(dismissed), 0)`,
    higherIsBetter: null, format: "pct1",
    isPhaseMetric: null, zeroIsData: false,
    minSampleComponent: "SUM(dismissed)",
  });
}

// ── Bowling ───────────────────────────────────────────────────────────────────
const BOWLING_METRICS = [
  {
    key: "matches",
    label: "Matches",
    shortLabel: "Mat",
    discipline: "bowling",
    source: "player_matches",
    sqlExpression: "COUNT(DISTINCT match_id)",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "COUNT(DISTINCT match_id)",
  },
  {
    key: "innings",
    label: "Innings",
    shortLabel: "Inns",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "COUNT(*)",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "COUNT(*)",
  },
  {
    key: "wickets",
    label: "Wickets",
    shortLabel: "Wkts",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(wickets)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(wickets)",
  },
  {
    key: "balls",
    label: "Balls Bowled",
    shortLabel: "Balls",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(balls)",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(balls)",
  },
  {
    key: "runs_conceded",
    label: "Runs Conceded",
    shortLabel: "Runs",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(runs_conceded)",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(runs_conceded)",
  },
  {
    key: "average",
    label: "Bowling Average",
    shortLabel: "Avg",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(runs_conceded) * 1.0 / NULLIF(SUM(wickets), 0)",
    higherIsBetter: false, // fewer runs per wicket is better
    format: "dec2",
    isPhaseMetric: null,
    zeroIsData: false,
    minSampleComponent: "SUM(wickets)",
  },
  {
    key: "economy",
    label: "Economy Rate",
    shortLabel: "Econ",
    discipline: "bowling",
    source: "innings",
    // Runs per over = runs / legal balls * 6. `balls` are legal balls; the
    // Hundred is NOT special-cased (SPEC).
    sqlExpression: "SUM(runs_conceded) * 6.0 / NULLIF(SUM(balls), 0)",
    higherIsBetter: false, format: "dec2",
    isPhaseMetric: null, zeroIsData: false,
    minSampleComponent: "SUM(balls)",
  },
  {
    key: "strike_rate",
    label: "Bowling Strike Rate",
    shortLabel: "SR",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(balls) * 1.0 / NULLIF(SUM(wickets), 0)",
    higherIsBetter: false, // fewer balls per wicket is better
    format: "dec2",
    isPhaseMetric: null,
    zeroIsData: false,
    minSampleComponent: "SUM(wickets)",
  },
  {
    key: "dot_pct",
    label: "Dot Ball %",
    shortLabel: "Dot%",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(dots) * 100.0 / NULLIF(SUM(balls), 0)",
    higherIsBetter: true, // bowling: MORE dots is better
    format: "pct1",
    isPhaseMetric: null,
    zeroIsData: false,
    minSampleComponent: "SUM(balls)",
  },
  {
    key: "boundary_pct_conceded",
    label: "Boundary % Conceded",
    shortLabel: "Bdry%",
    discipline: "bowling",
    source: "innings",
    // Boundary balls conceded = fours_conceded + sixes_conceded (view already
    // applies the is_not_boundary rule).
    sqlExpression: "(SUM(fours_conceded) + SUM(sixes_conceded)) * 100.0 / NULLIF(SUM(balls), 0)",
    higherIsBetter: false, // fewer boundaries conceded is better
    format: "pct1",
    isPhaseMetric: null,
    zeroIsData: false,
    minSampleComponent: "SUM(balls)",
  },
  {
    key: "maidens",
    label: "Maidens",
    shortLabel: "Mdns",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(maidens)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(maidens)",
  },
  {
    key: "wickets_per_innings",
    label: "Wickets per Innings",
    shortLabel: "WPI",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(wickets) * 1.0 / NULLIF(COUNT(*), 0)",
    higherIsBetter: true, format: "dec2",
    isPhaseMetric: null, zeroIsData: false,
    minSampleComponent: "COUNT(*)",
  },
  {
    key: "best",
    label: "Best Bowling (Innings)",
    shortLabel: "BBI",
    discipline: "bowling",
    source: "innings",
    // Display "W-R" of the single best innings via arg_max on
    // rank = wickets*1000 - runs_conceded: more wickets always wins; at equal
    // wickets fewer runs wins (runs_conceded < 1000 always). So 5-23 (4977) >
    // 5-40 (4960) > any 4-for (<4000). 0-wicket innings still yield a BBI
    // ("0-12"); NULL only with no bowling rows (never in the grouped query).
    // CAST to INTEGER so it reads "8-7" not "8.0-7.0".
    sqlExpression:
      "arg_max(CAST(wickets AS INTEGER) || '-' || CAST(runs_conceded AS INTEGER), wickets * 1000 - runs_conceded)",
    sortExpression: "MAX(wickets * 1000 - runs_conceded)",
    higherIsBetter: true, format: "str",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "COUNT(*)",
  },
  // Wicket-type breakdown (D4): the bowler-credited wickets split by dismissal
  // kind. The six sum exactly to `wickets` (verified against raw deliveries).
  // Counts, so zeroIsData:true — a bowler with no stumpings shows "0", not "—".
  {
    key: "wkt_bowled",
    label: "Bowled",
    shortLabel: "Bowled",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(wickets_bowled)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(wickets_bowled)",
  },
  {
    key: "wkt_lbw",
    label: "LBW",
    shortLabel: "LBW",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(wickets_lbw)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(wickets_lbw)",
  },
  {
    key: "wkt_caught",
    label: "Caught",
    shortLabel: "Caught",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(wickets_caught)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(wickets_caught)",
  },
  {
    key: "wkt_caught_and_bowled",
    label: "Caught & Bowled",
    shortLabel: "c&b",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(wickets_caught_and_bowled)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(wickets_caught_and_bowled)",
  },
  {
    key: "wkt_stumped",
    label: "Stumped",
    shortLabel: "Stumped",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(wickets_stumped)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(wickets_stumped)",
  },
  {
    key: "wkt_hit_wicket",
    label: "Hit Wicket",
    shortLabel: "Hit Wkt",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(wickets_hit_wicket)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(wickets_hit_wicket)",
  },
  // Phase economy + wickets — T20 ranges.
  {
    key: "pp_economy",
    label: "Powerplay Economy",
    shortLabel: "PP Econ",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(pp_runs_conceded) * 6.0 / NULLIF(SUM(pp_balls), 0)",
    higherIsBetter: false, format: "dec2",
    isPhaseMetric: "t20", zeroIsData: false,
    minSampleComponent: "SUM(pp_balls)",
  },
  {
    key: "death_economy",
    label: "Death Overs Economy",
    shortLabel: "Death Econ",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(death_runs_conceded) * 6.0 / NULLIF(SUM(death_balls), 0)",
    higherIsBetter: false, format: "dec2",
    isPhaseMetric: "t20", zeroIsData: false,
    minSampleComponent: "SUM(death_balls)",
  },
  {
    key: "pp_wickets",
    label: "Powerplay Wickets",
    shortLabel: "PP Wkts",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(pp_wickets)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: "t20", zeroIsData: true,
    minSampleComponent: "SUM(pp_wickets)",
  },
  {
    key: "death_wickets",
    label: "Death Overs Wickets",
    shortLabel: "Death Wkts",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(death_wickets)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: "t20", zeroIsData: true,
    minSampleComponent: "SUM(death_wickets)",
  },
  // Phase economy + wickets — ODI ranges.
  {
    key: "odi_pp_economy",
    label: "ODI Powerplay Economy",
    shortLabel: "ODI PP Econ",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(odi_pp_runs_conceded) * 6.0 / NULLIF(SUM(odi_pp_balls), 0)",
    higherIsBetter: false, format: "dec2",
    isPhaseMetric: "odi", zeroIsData: false,
    minSampleComponent: "SUM(odi_pp_balls)",
  },
  {
    key: "odi_death_economy",
    label: "ODI Death Overs Economy",
    shortLabel: "ODI Death Econ",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(odi_death_runs_conceded) * 6.0 / NULLIF(SUM(odi_death_balls), 0)",
    higherIsBetter: false, format: "dec2",
    isPhaseMetric: "odi", zeroIsData: false,
    minSampleComponent: "SUM(odi_death_balls)",
  },
  {
    key: "odi_pp_wickets",
    label: "ODI Powerplay Wickets",
    shortLabel: "ODI PP Wkts",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(odi_pp_wickets)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: "odi", zeroIsData: true,
    minSampleComponent: "SUM(odi_pp_wickets)",
  },
  {
    key: "odi_death_wickets",
    label: "ODI Death Overs Wickets",
    shortLabel: "ODI Death Wkts",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(odi_death_wickets)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: "odi", zeroIsData: true,
    minSampleComponent: "SUM(odi_death_wickets)",
  },
];

// ── Matchups (D4 R3) ─────────────────────────────────────────────────────────
// Batter-vs-bowling-style and bowler-vs-batting-hand splits. Base tables are
// the `matchup_batting` / `matchup_bowling` views (grain: one row per
// match-innings-player-bucket), themselves built from `deliveries` in the
// pipeline with every SPEC §4.1 rule already baked in — same posture as the
// batting/bowling innings views (see file header). `source: "matchup"` marks
// these as a third query family (src/playerData.js's matchup fetchers own the
// coverage N-of-M line and the '(unmapped)' bucket exclusion; these entries
// are plain aggregate expressions over the already-filtered/grouped rows).
const MATCHUP_BATTING_METRICS = [
  {
    key: "innings",
    label: "Innings",
    shortLabel: "Inns",
    discipline: "matchup_batting",
    source: "matchup",
    // matchup_batting's grain is (match_id, innings_number, batter_id,
    // bowling_type) — one row per (match, innings, bucket) at the FINE
    // (bowling_type) view, so COUNT(*) alone would be correct there. But
    // coarse views (GROUP BY bowling_group, e.g. Pace/Spin — including the
    // leaderboard Vs mode) collapse multiple bowling_type rows into one
    // group, and a single match-innings can span several bowling_type
    // buckets (e.g. faced both off-spin and leg-spin in the same innings).
    // COUNT(*) there would double/triple-count innings. Count distinct
    // (match, innings) pairs instead — exactly what "innings" means
    // regardless of grouping grain, matching matchup_bowling's innings
    // metric (D4-R4 hardening) below.
    sqlExpression: "COUNT(DISTINCT match_id || ':' || CAST(innings_number AS VARCHAR))",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "COUNT(DISTINCT match_id || ':' || CAST(innings_number AS VARCHAR))",
  },
  {
    key: "balls",
    label: "Balls Faced",
    shortLabel: "BF",
    discipline: "matchup_batting",
    source: "matchup",
    sqlExpression: "SUM(balls_faced)",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(balls_faced)",
  },
  {
    key: "runs",
    label: "Runs",
    shortLabel: "Runs",
    discipline: "matchup_batting",
    source: "matchup",
    sqlExpression: "SUM(runs)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(runs)",
  },
  {
    key: "strike_rate",
    label: "Strike Rate",
    shortLabel: "SR",
    discipline: "matchup_batting",
    source: "matchup",
    sqlExpression: "SUM(runs) * 100.0 / NULLIF(SUM(balls_faced), 0)",
    higherIsBetter: true, format: "dec2",
    isPhaseMetric: null, zeroIsData: false,
    minSampleComponent: "SUM(balls_faced)",
  },
  {
    key: "average",
    label: "Average (vs style)",
    shortLabel: "Avg",
    discipline: "matchup_batting",
    source: "matchup",
    // Denominator is bowler-credited dismissals only (decision 23) — the
    // view's `dismissals` column already excludes run-outs etc.
    sqlExpression: "SUM(runs) * 1.0 / NULLIF(SUM(dismissals), 0)",
    higherIsBetter: true, format: "dec2",
    isPhaseMetric: null, zeroIsData: false,
    minSampleComponent: "SUM(dismissals)",
  },
  {
    key: "dismissals",
    label: "Dismissals",
    shortLabel: "Dis",
    discipline: "matchup_batting",
    source: "matchup",
    // Bowler-credited kinds only (decision 23); fewer dismissals against a
    // given style is better for the batter.
    sqlExpression: "SUM(dismissals)",
    higherIsBetter: false, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(dismissals)",
  },
  {
    key: "dot_pct",
    label: "Dot Ball %",
    shortLabel: "Dot%",
    discipline: "matchup_batting",
    source: "matchup",
    sqlExpression: "SUM(dots) * 100.0 / NULLIF(SUM(balls_faced), 0)",
    higherIsBetter: false, // batting: fewer dots is better
    format: "pct1",
    isPhaseMetric: null, zeroIsData: false,
    minSampleComponent: "SUM(balls_faced)",
  },
  {
    key: "boundary_pct",
    label: "Boundary %",
    shortLabel: "Bdry%",
    discipline: "matchup_batting",
    source: "matchup",
    sqlExpression: "(SUM(fours_hit) + SUM(sixes_hit)) * 100.0 / NULLIF(SUM(balls_faced), 0)",
    higherIsBetter: true, format: "pct1",
    isPhaseMetric: null, zeroIsData: false,
    minSampleComponent: "SUM(balls_faced)",
  },
  {
    key: "fours",
    label: "Fours",
    shortLabel: "4s",
    discipline: "matchup_batting",
    source: "matchup",
    sqlExpression: "SUM(fours_hit)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(fours_hit)",
  },
  {
    key: "sixes",
    label: "Sixes",
    shortLabel: "6s",
    discipline: "matchup_batting",
    source: "matchup",
    sqlExpression: "SUM(sixes_hit)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(sixes_hit)",
  },
  {
    key: "balls_per_boundary",
    label: "Balls per Boundary",
    shortLabel: "BPB",
    discipline: "matchup_batting",
    source: "matchup",
    sqlExpression: "SUM(balls_faced) * 1.0 / NULLIF(SUM(fours_hit) + SUM(sixes_hit), 0)",
    higherIsBetter: false, // fewer balls between boundaries is better
    format: "dec1",
    isPhaseMetric: null, zeroIsData: false,
    minSampleComponent: "SUM(fours_hit) + SUM(sixes_hit)",
  },
  {
    key: "balls_per_dismissal",
    label: "Balls per Dismissal",
    shortLabel: "BPD",
    discipline: "matchup_batting",
    source: "matchup",
    sqlExpression: "SUM(balls_faced) * 1.0 / NULLIF(SUM(dismissals), 0)",
    higherIsBetter: true, format: "dec1",
    isPhaseMetric: null, zeroIsData: false,
    minSampleComponent: "SUM(dismissals)",
  },
  // Dismissal-kind breakdown (D4 R3 follow-up): bowler-credited dismissal kinds
  // against this bucket. Counts, so zeroIsData:true. NOTE: the dis_* columns
  // land via a concurrent pipeline extension and are not yet on R2 (see task
  // note) — defined here so the picker/vocabulary is ready when they arrive.
  {
    key: "dis_bowled",
    label: "Out Bowled",
    shortLabel: "Bwd",
    discipline: "matchup_batting",
    source: "matchup",
    section: "dismissal",
    sqlExpression: "SUM(dis_bowled)",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(dis_bowled)",
  },
  {
    key: "dis_lbw",
    label: "Out LBW",
    shortLabel: "LBW",
    discipline: "matchup_batting",
    source: "matchup",
    section: "dismissal",
    sqlExpression: "SUM(dis_lbw)",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(dis_lbw)",
  },
  {
    key: "dis_caught",
    label: "Out Caught",
    shortLabel: "Ct",
    discipline: "matchup_batting",
    source: "matchup",
    section: "dismissal",
    sqlExpression: "SUM(dis_caught)",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(dis_caught)",
  },
  {
    key: "dis_caught_and_bowled",
    label: "Out Caught & Bowled",
    shortLabel: "C&B",
    discipline: "matchup_batting",
    source: "matchup",
    section: "dismissal",
    sqlExpression: "SUM(dis_caught_and_bowled)",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(dis_caught_and_bowled)",
  },
  {
    key: "dis_stumped",
    label: "Out Stumped",
    shortLabel: "St",
    discipline: "matchup_batting",
    source: "matchup",
    section: "dismissal",
    sqlExpression: "SUM(dis_stumped)",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(dis_stumped)",
  },
  {
    key: "dis_hit_wicket",
    label: "Out Hit Wicket",
    shortLabel: "HW",
    discipline: "matchup_batting",
    source: "matchup",
    section: "dismissal",
    sqlExpression: "SUM(dis_hit_wicket)",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(dis_hit_wicket)",
  },
  // Phase strike rates — T20 ranges. Same pp_*/mid_*/death_* column family as
  // the main batting namespace's phase metrics (not yet live on R2 for the
  // matchup views — see task note).
  {
    key: "pp_strike_rate",
    label: "Powerplay Strike Rate",
    shortLabel: "PP SR",
    discipline: "matchup_batting",
    source: "matchup",
    sqlExpression: "SUM(pp_runs) * 100.0 / NULLIF(SUM(pp_balls), 0)",
    higherIsBetter: true, format: "dec2",
    isPhaseMetric: "t20", zeroIsData: false,
    minSampleComponent: "SUM(pp_balls)",
  },
  {
    key: "mid_strike_rate",
    label: "Middle Overs Strike Rate",
    shortLabel: "Mid SR",
    discipline: "matchup_batting",
    source: "matchup",
    sqlExpression: "SUM(mid_runs) * 100.0 / NULLIF(SUM(mid_balls), 0)",
    higherIsBetter: true, format: "dec2",
    isPhaseMetric: "t20", zeroIsData: false,
    minSampleComponent: "SUM(mid_balls)",
  },
  {
    key: "death_strike_rate",
    label: "Death Overs Strike Rate",
    shortLabel: "Death SR",
    discipline: "matchup_batting",
    source: "matchup",
    sqlExpression: "SUM(death_runs) * 100.0 / NULLIF(SUM(death_balls), 0)",
    higherIsBetter: true, format: "dec2",
    isPhaseMetric: "t20", zeroIsData: false,
    minSampleComponent: "SUM(death_balls)",
  },
  // Phase strike rates — ODI ranges.
  {
    key: "odi_pp_strike_rate",
    label: "ODI Powerplay Strike Rate",
    shortLabel: "ODI PP SR",
    discipline: "matchup_batting",
    source: "matchup",
    sqlExpression: "SUM(odi_pp_runs) * 100.0 / NULLIF(SUM(odi_pp_balls), 0)",
    higherIsBetter: true, format: "dec2",
    isPhaseMetric: "odi", zeroIsData: false,
    minSampleComponent: "SUM(odi_pp_balls)",
  },
  {
    key: "odi_mid_strike_rate",
    label: "ODI Middle Overs Strike Rate",
    shortLabel: "ODI Mid SR",
    discipline: "matchup_batting",
    source: "matchup",
    sqlExpression: "SUM(odi_mid_runs) * 100.0 / NULLIF(SUM(odi_mid_balls), 0)",
    higherIsBetter: true, format: "dec2",
    isPhaseMetric: "odi", zeroIsData: false,
    minSampleComponent: "SUM(odi_mid_balls)",
  },
  {
    key: "odi_death_strike_rate",
    label: "ODI Death Overs Strike Rate",
    shortLabel: "ODI Death SR",
    discipline: "matchup_batting",
    source: "matchup",
    sqlExpression: "SUM(odi_death_runs) * 100.0 / NULLIF(SUM(odi_death_balls), 0)",
    higherIsBetter: true, format: "dec2",
    isPhaseMetric: "odi", zeroIsData: false,
    minSampleComponent: "SUM(odi_death_balls)",
  },
];

const MATCHUP_BOWLING_METRICS = [
  {
    key: "innings",
    label: "Innings",
    shortLabel: "Inns",
    discipline: "matchup_bowling",
    source: "matchup",
    // D4-R4 GRAIN CHANGE: matchup_bowling's primary key gained a 5th column,
    // batting_position (the striker's position at each delivery), so a single
    // match-innings-bowler-hand combination now spans MULTIPLE rows (one per
    // position bucket faced). COUNT(*) would overcount innings by the number
    // of distinct positions faced, so we count distinct (match, innings)
    // pairs instead — exactly what "innings" means regardless of grain.
    sqlExpression: "COUNT(DISTINCT match_id || ':' || CAST(innings_number AS VARCHAR))",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "COUNT(DISTINCT match_id || ':' || CAST(innings_number AS VARCHAR))",
  },
  {
    key: "balls",
    label: "Balls Bowled",
    shortLabel: "Balls",
    discipline: "matchup_bowling",
    source: "matchup",
    sqlExpression: "SUM(balls)",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(balls)",
  },
  {
    key: "runs_conceded",
    label: "Runs Conceded",
    shortLabel: "Runs",
    discipline: "matchup_bowling",
    source: "matchup",
    sqlExpression: "SUM(runs_conceded)",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(runs_conceded)",
  },
  {
    key: "wickets",
    label: "Wickets",
    shortLabel: "Wkts",
    discipline: "matchup_bowling",
    source: "matchup",
    sqlExpression: "SUM(wickets)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(wickets)",
  },
  {
    key: "economy",
    label: "Economy Rate",
    shortLabel: "Econ",
    discipline: "matchup_bowling",
    source: "matchup",
    sqlExpression: "SUM(runs_conceded) * 6.0 / NULLIF(SUM(balls), 0)",
    higherIsBetter: false, format: "dec2",
    isPhaseMetric: null, zeroIsData: false,
    minSampleComponent: "SUM(balls)",
  },
  {
    key: "average",
    label: "Average (vs hand)",
    shortLabel: "Avg",
    discipline: "matchup_bowling",
    source: "matchup",
    sqlExpression: "SUM(runs_conceded) * 1.0 / NULLIF(SUM(wickets), 0)",
    higherIsBetter: false, format: "dec2",
    isPhaseMetric: null, zeroIsData: false,
    minSampleComponent: "SUM(wickets)",
  },
  {
    key: "strike_rate",
    label: "Bowling Strike Rate",
    shortLabel: "SR",
    discipline: "matchup_bowling",
    source: "matchup",
    sqlExpression: "SUM(balls) * 1.0 / NULLIF(SUM(wickets), 0)",
    higherIsBetter: false, format: "dec2",
    isPhaseMetric: null, zeroIsData: false,
    minSampleComponent: "SUM(wickets)",
  },
  {
    key: "dot_pct",
    label: "Dot Ball %",
    shortLabel: "Dot%",
    discipline: "matchup_bowling",
    source: "matchup",
    sqlExpression: "SUM(dots) * 100.0 / NULLIF(SUM(balls), 0)",
    higherIsBetter: true, // bowling: MORE dots is better
    format: "pct1",
    isPhaseMetric: null, zeroIsData: false,
    minSampleComponent: "SUM(balls)",
  },
  {
    key: "boundary_pct_conceded",
    label: "Boundary % Conceded",
    shortLabel: "Bdry%",
    discipline: "matchup_bowling",
    source: "matchup",
    sqlExpression: "(SUM(fours_conceded) + SUM(sixes_conceded)) * 100.0 / NULLIF(SUM(balls), 0)",
    higherIsBetter: false, format: "pct1",
    isPhaseMetric: null, zeroIsData: false,
    minSampleComponent: "SUM(balls)",
  },
  {
    key: "fours_conceded",
    label: "Fours Conceded",
    shortLabel: "4s",
    discipline: "matchup_bowling",
    source: "matchup",
    sqlExpression: "SUM(fours_conceded)",
    higherIsBetter: false, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(fours_conceded)",
  },
  {
    key: "sixes_conceded",
    label: "Sixes Conceded",
    shortLabel: "6s",
    discipline: "matchup_bowling",
    source: "matchup",
    sqlExpression: "SUM(sixes_conceded)",
    higherIsBetter: false, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(sixes_conceded)",
  },
  {
    key: "wickets_per_innings",
    label: "Wickets per Innings",
    shortLabel: "WPI",
    discipline: "matchup_bowling",
    source: "matchup",
    // Same D4-R4 grain-change reasoning as the "innings" metric above: the
    // denominator must count distinct (match, innings) pairs, not rows, since
    // rows are now split across striker-position buckets.
    sqlExpression:
      "SUM(wickets) * 1.0 / NULLIF(COUNT(DISTINCT match_id || ':' || CAST(innings_number AS VARCHAR)), 0)",
    higherIsBetter: true, format: "dec2",
    isPhaseMetric: null, zeroIsData: false,
    minSampleComponent: "COUNT(DISTINCT match_id || ':' || CAST(innings_number AS VARCHAR))",
  },
  // Wicket-kind breakdown (D4 R3 follow-up): bowler-credited wicket kinds
  // against this batting-hand bucket. Counts, so zeroIsData:true. NOTE: the
  // wkt_* columns land via a concurrent pipeline extension and are not yet on
  // R2 (see task note) — defined here so the picker/vocabulary is ready.
  {
    key: "wkt_bowled",
    label: "Bowled",
    shortLabel: "Bowled",
    discipline: "matchup_bowling",
    source: "matchup",
    section: "dismissal",
    sqlExpression: "SUM(wkt_bowled)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(wkt_bowled)",
  },
  {
    key: "wkt_lbw",
    label: "LBW",
    shortLabel: "LBW",
    discipline: "matchup_bowling",
    source: "matchup",
    section: "dismissal",
    sqlExpression: "SUM(wkt_lbw)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(wkt_lbw)",
  },
  {
    key: "wkt_caught",
    label: "Caught",
    shortLabel: "Caught",
    discipline: "matchup_bowling",
    source: "matchup",
    section: "dismissal",
    sqlExpression: "SUM(wkt_caught)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(wkt_caught)",
  },
  {
    key: "wkt_caught_and_bowled",
    label: "Caught & Bowled",
    shortLabel: "c&b",
    discipline: "matchup_bowling",
    source: "matchup",
    section: "dismissal",
    sqlExpression: "SUM(wkt_caught_and_bowled)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(wkt_caught_and_bowled)",
  },
  {
    key: "wkt_stumped",
    label: "Stumped",
    shortLabel: "Stumped",
    discipline: "matchup_bowling",
    source: "matchup",
    section: "dismissal",
    sqlExpression: "SUM(wkt_stumped)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(wkt_stumped)",
  },
  {
    key: "wkt_hit_wicket",
    label: "Hit Wicket",
    shortLabel: "Hit Wkt",
    discipline: "matchup_bowling",
    source: "matchup",
    section: "dismissal",
    sqlExpression: "SUM(wkt_hit_wicket)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    minSampleComponent: "SUM(wkt_hit_wicket)",
  },
  // Phase economy + wickets — T20 ranges. Same pp_*/mid_*/death_* column
  // family as the main bowling namespace's phase metrics (not yet live on R2
  // for the matchup views — see task note).
  {
    key: "pp_economy",
    label: "Powerplay Economy",
    shortLabel: "PP Econ",
    discipline: "matchup_bowling",
    source: "matchup",
    sqlExpression: "SUM(pp_runs_conceded) * 6.0 / NULLIF(SUM(pp_balls), 0)",
    higherIsBetter: false, format: "dec2",
    isPhaseMetric: "t20", zeroIsData: false,
    minSampleComponent: "SUM(pp_balls)",
  },
  {
    key: "mid_economy",
    label: "Middle Overs Economy",
    shortLabel: "Mid Econ",
    discipline: "matchup_bowling",
    source: "matchup",
    sqlExpression: "SUM(mid_runs_conceded) * 6.0 / NULLIF(SUM(mid_balls), 0)",
    higherIsBetter: false, format: "dec2",
    isPhaseMetric: "t20", zeroIsData: false,
    minSampleComponent: "SUM(mid_balls)",
  },
  {
    key: "death_economy",
    label: "Death Overs Economy",
    shortLabel: "Death Econ",
    discipline: "matchup_bowling",
    source: "matchup",
    sqlExpression: "SUM(death_runs_conceded) * 6.0 / NULLIF(SUM(death_balls), 0)",
    higherIsBetter: false, format: "dec2",
    isPhaseMetric: "t20", zeroIsData: false,
    minSampleComponent: "SUM(death_balls)",
  },
  {
    key: "pp_wickets",
    label: "Powerplay Wickets",
    shortLabel: "PP Wkts",
    discipline: "matchup_bowling",
    source: "matchup",
    sqlExpression: "SUM(pp_wickets)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: "t20", zeroIsData: true,
    minSampleComponent: "SUM(pp_wickets)",
  },
  {
    key: "mid_wickets",
    label: "Middle Overs Wickets",
    shortLabel: "Mid Wkts",
    discipline: "matchup_bowling",
    source: "matchup",
    sqlExpression: "SUM(mid_wickets)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: "t20", zeroIsData: true,
    minSampleComponent: "SUM(mid_wickets)",
  },
  {
    key: "death_wickets",
    label: "Death Overs Wickets",
    shortLabel: "Death Wkts",
    discipline: "matchup_bowling",
    source: "matchup",
    sqlExpression: "SUM(death_wickets)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: "t20", zeroIsData: true,
    minSampleComponent: "SUM(death_wickets)",
  },
  // Phase economy + wickets — ODI ranges.
  {
    key: "odi_pp_economy",
    label: "ODI Powerplay Economy",
    shortLabel: "ODI PP Econ",
    discipline: "matchup_bowling",
    source: "matchup",
    sqlExpression: "SUM(odi_pp_runs_conceded) * 6.0 / NULLIF(SUM(odi_pp_balls), 0)",
    higherIsBetter: false, format: "dec2",
    isPhaseMetric: "odi", zeroIsData: false,
    minSampleComponent: "SUM(odi_pp_balls)",
  },
  {
    key: "odi_mid_economy",
    label: "ODI Middle Overs Economy",
    shortLabel: "ODI Mid Econ",
    discipline: "matchup_bowling",
    source: "matchup",
    sqlExpression: "SUM(odi_mid_runs_conceded) * 6.0 / NULLIF(SUM(odi_mid_balls), 0)",
    higherIsBetter: false, format: "dec2",
    isPhaseMetric: "odi", zeroIsData: false,
    minSampleComponent: "SUM(odi_mid_balls)",
  },
  {
    key: "odi_death_economy",
    label: "ODI Death Overs Economy",
    shortLabel: "ODI Death Econ",
    discipline: "matchup_bowling",
    source: "matchup",
    sqlExpression: "SUM(odi_death_runs_conceded) * 6.0 / NULLIF(SUM(odi_death_balls), 0)",
    higherIsBetter: false, format: "dec2",
    isPhaseMetric: "odi", zeroIsData: false,
    minSampleComponent: "SUM(odi_death_balls)",
  },
  {
    key: "odi_pp_wickets",
    label: "ODI Powerplay Wickets",
    shortLabel: "ODI PP Wkts",
    discipline: "matchup_bowling",
    source: "matchup",
    sqlExpression: "SUM(odi_pp_wickets)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: "odi", zeroIsData: true,
    minSampleComponent: "SUM(odi_pp_wickets)",
  },
  {
    key: "odi_mid_wickets",
    label: "ODI Middle Overs Wickets",
    shortLabel: "ODI Mid Wkts",
    discipline: "matchup_bowling",
    source: "matchup",
    sqlExpression: "SUM(odi_mid_wickets)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: "odi", zeroIsData: true,
    minSampleComponent: "SUM(odi_mid_wickets)",
  },
  {
    key: "odi_death_wickets",
    label: "ODI Death Overs Wickets",
    shortLabel: "ODI Death Wkts",
    discipline: "matchup_bowling",
    source: "matchup",
    sqlExpression: "SUM(odi_death_wickets)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: "odi", zeroIsData: true,
    minSampleComponent: "SUM(odi_death_wickets)",
  },
];

export const METRICS = [...BATTING_METRICS, ...BOWLING_METRICS, ...MATCHUP_BATTING_METRICS, ...MATCHUP_BOWLING_METRICS];

// key is unique only within a discipline (batting & bowling share e.g. "average",
// "strike_rate", "dot_pct", "innings", "matches"). Index by discipline+key.
const _byDisciplineKey = new Map();
for (const m of METRICS) {
  _byDisciplineKey.set(`${m.discipline}:${m.key}`, m);
}

/** All metrics for a discipline ("batting" | "bowling"), in catalogue order. */
export function metricsFor(discipline) {
  return METRICS.filter((m) => m.discipline === discipline);
}

/**
 * Look up a metric. Pass the discipline to disambiguate shared keys; without it,
 * returns the first metric with that key (batting wins, then bowling).
 */
export function getMetric(key, discipline) {
  if (discipline) return _byDisciplineKey.get(`${discipline}:${key}`) ?? null;
  return METRICS.find((m) => m.key === key) ?? null;
}

/**
 * §8.1 no-data test. Returns true if `value` is real data for `metric`.
 *   • rate/ratio metrics (zeroIsData false): 0 or NULL/undefined/NaN → no data.
 *   • raw totals (zeroIsData true): only NULL/undefined/NaN → no data (0 is real).
 * String metrics (BBI) are data whenever non-null/non-empty.
 */
export function hasMetricData(metric, value) {
  if (value === null || value === undefined) return false;
  if (metric.format === "str") return value !== "";
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(n)) return false;
  if (metric.zeroIsData) return true;
  return n !== 0;
}

/**
 * Display label for a matchup bucket value (bowling_type / bowling_group /
 * batting_hand from matchup_batting / matchup_bowling). Callers must exclude
 * '(unmapped)' rows themselves (decision 21) — this function should never see
 * that value. Decision 24: bare-slow bowlers surface as the bare group name
 * 'Spin'/'Pace' in the fine (bowling_type) view, and read as "…(unspecified)"
 * there; every other value (specific styles, batting_hand) passes through
 * verbatim.
 */
export function matchupBucketLabel(bucket) {
  if (bucket === "Spin") return "Spin (unspecified)";
  if (bucket === "Pace") return "Pace (unspecified)";
  return bucket;
}
