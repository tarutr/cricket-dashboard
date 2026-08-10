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
// EXCEPTION: some metrics cannot be computed from the innings views (a player
// may appear in a match without batting or bowling, and fielding is a wicket-
// event concept) — they read a separate view via a per-player CTE the table
// builder LEFT JOINs onto the batting/bowling GROUP BY. Three shapes:
//   • `matches` (source "player_matches") — a SEPARATE grouped query over
//     player_matches with the SAME match-level filters, joined on player_id in JS.
//   • Fielding (source "fielding_events": catches / stumpings / run_outs /
//     dismissals_effected) — surfaced IN the main sql via a per-fielder
//     pre-aggregated `fielding_cte` over the EVENT-GRAIN `fielding` view (one row
//     per fielder over the scoped fielding_events, substitutes excluded), so their
//     `sqlExpression` is `MAX(fielding_cte.<col>)`.
//   • Impact (source "player_matches": player_of_match) — same shape via a
//     parallel per-player `pom_cte` over player_matches: `MAX(pom_cte.<col>)`.
// Each CTE is one row per player, so the join never multiplies innings rows and
// existing aggregates stay byte-identical. Living in the main sql lets them also
// drive HAVING (stat conditions) and the graph pool, which `matches` cannot.
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
//   format         — "int" | "dec1" | "dec2" | "pct1" | "str" | "overs".
//                    "overs" is DISPLAY-ONLY cricket O.B notation for a
//                    SUM(balls) total: the stored/sorted value is the raw legal
//                    ball count (an int), rendered as floor(balls/6).(balls%6)
//                    — e.g. 120 → "20.0", 125 → "20.5". Never do arithmetic on
//                    the O.B string; sort/aggregate use the raw ball count.
//   isPhaseMetric  — null | "t20" | "odi".
//   zeroIsData     — true for raw totals; false for rates/ratios/averages.
//   additive       — true iff summing several players' values yields a
//                    meaningful combined total (counts/sums: innings, runs,
//                    wickets, dismissal-kind counts, ...). Omitted (falsy) for
//                    everything else, including rates/ratios/averages AND raw
//                    totals that aren't sums — e.g. High Score is MAX(runs),
//                    not additive, even though it's an int/zeroIsData:true
//                    total. The Graph Builder's donut chart (src/graph/graph.js)
//                    is the one place this matters (a donut is a share-of-total
//                    view, meaningless for a non-additive metric) — it filters
//                    on this flag directly rather than re-deriving additivity
//                    from format/zeroIsData.
//   kind           — metric taxonomy (decision 43): "total" (additive counting
//                    stat — runs/balls/innings/wickets/dismissal counts/…),
//                    "rate" (per-something ratio — average/SR/economy/…),
//                    "percent" (share-of-whole % — dot%/boundary%/Out X %/…), or
//                    "peak" (best/extreme of a single innings — High Score, BBI).
//                    Gates which chart types accept a metric (totals→donut,
//                    rates/percents→slope, peaks excluded from most); pure
//                    metadata, orthogonal to sqlExpression. A 5th value,
//                    "position" (R3 Wave 5 polish), is used by exactly one
//                    metric (batting's `r_pos`) — deliberately NOT one of the
//                    four above so it's excluded from every existing kind-based
//                    Graph Builder filter (`m.kind === "total"/"rate"/
//                    "percent"`, `m.additive === true`, `timeseriesSupported`)
//                    without needing to touch any of that code: a batting
//                    position is a table-display label, not a summable/
//                    trend-able/rankable stat.
//   columnTitle    — optional hover title for the column header (`<th
//                    title="...">`), beyond the plain shortLabel text. Only
//                    `r_pos` uses this today.
//   vsTableOnly    — decision 47(c): true iff a matchup metric belongs ONLY to
//                    the leaderboard "Vs" TABLE (its restricted column picker),
//                    never the player pop-up's matchup tables (a separate
//                    surface — playerData.js's MATCHUP_*_KEYS filter it out) nor
//                    the graph (which never sees the matchup namespaces anyway).
//                    Carried by the four decision-47(c) additions only.
//   peakInner /    — decision 47(c) two-step PEAK recipe for the matchup
//   peakOuter /      namespaces' High Score / Best Bowling. A matchup peak is a
//   peakOuterSort    per-INNINGS extreme, but buildMatchupQuery's step-1 GROUP BY
//                    (id, name) has already collapsed innings, so it can't be a
//                    step-1 aggregate. Instead table.js pre-aggregates each
//                    innings — `peakInner` is the inner SELECT's per-(id, match,
//                    innings) aggregate(s), bucket-FILTER'd via WHERE — then
//                    `peakOuter` reduces those per-innings values to the player's
//                    peak (MAX / arg_max), and `peakOuterSort` (optional) is the
//                    numeric rank for str-format peaks (Best Bowling). Only
//                    present on `kind:"peak"` matchup metrics; their
//                    `sqlExpression` (and Best Bowling's `sortExpression`) is a
//                    placeholder NEVER interpolated, like composition/r_pos.

// ── Batting ───────────────────────────────────────────────────────────────────
const BATTING_METRICS = [
  {
    key: "matches",
    label: "Player Matches",
    shortLabel: "Mat",
    discipline: "batting",
    source: "player_matches",
    sqlExpression: "COUNT(DISTINCT match_id)",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
  },
  {
    key: "innings",
    label: "Batting Innings",
    shortLabel: "Bat Inns",
    discipline: "batting",
    source: "innings",
    sqlExpression: "COUNT(*)",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    kind: "peak",
  },
  {
    key: "average",
    label: "Batting Average",
    shortLabel: "Bat Avg",
    discipline: "batting",
    source: "innings",
    // Runs per dismissal. Not-outs (dismissed = 0) are excluded from the
    // denominator by construction — SUM(dismissed) counts only dismissals.
    sqlExpression: "SUM(runs) * 1.0 / NULLIF(SUM(dismissed), 0)",
    higherIsBetter: true, format: "dec2",
    isPhaseMetric: null, zeroIsData: false,
    kind: "rate",
  },
  {
    key: "strike_rate",
    label: "Batting Strike Rate",
    shortLabel: "Bat SR",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(runs) * 100.0 / NULLIF(SUM(balls_faced), 0)",
    higherIsBetter: true, format: "dec2",
    isPhaseMetric: null, zeroIsData: false,
    kind: "rate",
  },
  {
    key: "balls_per_dismissal",
    label: "Balls per Dismissal",
    shortLabel: "BpD",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(balls_faced) * 1.0 / NULLIF(SUM(dismissed), 0)",
    higherIsBetter: true, format: "dec1",
    isPhaseMetric: null, zeroIsData: false,
    kind: "rate",
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
    kind: "percent",
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
    kind: "percent",
  },
  {
    key: "balls_per_boundary",
    label: "Balls per Boundary",
    shortLabel: "BpB",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(balls_faced) * 1.0 / NULLIF(SUM(fours_hit) + SUM(sixes_hit), 0)",
    higherIsBetter: false, // fewer balls between boundaries is better
    format: "dec1",
    isPhaseMetric: null,
    zeroIsData: false,
    kind: "rate",
  },
  {
    key: "fours",
    label: "4s",
    shortLabel: "4s",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(fours_hit)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
  },
  {
    key: "sixes",
    label: "6s",
    shortLabel: "6s",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(sixes_hit)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
  },
  // Milestone / innings-outcome counts (Wave 0). Each is a plain per-innings
  // CASE tally over columns the batting view already carries (runs, dismissed),
  // mirroring the fours/sixes counting-total shape exactly. Statsguru
  // convention: a "fifty" is 50–99 (hundreds counted separately, never
  // double-counted). A duck is out for 0 (dismissed = 1), which includes the
  // diamond duck. Not Outs counts innings the batter finished undismissed.
  {
    key: "fifties",
    label: "50s",
    shortLabel: "50s",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(CASE WHEN runs BETWEEN 50 AND 99 THEN 1 ELSE 0 END)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
  },
  {
    key: "hundreds",
    label: "100s",
    shortLabel: "100s",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(CASE WHEN runs >= 100 THEN 1 ELSE 0 END)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
  },
  // Innings Score >= N (filter-rejig Wave R1): count of the batter's innings whose
  // per-innings runs meet a user-supplied threshold N — the batting analog of
  // Wicket Hauls >= N. A PARAMETRISED threshold metric: the Wave R2 sub-filter
  // supplies N, then a count operator + value on the resulting COUNT. Until R2
  // wires the N input, `sqlExpression` carries the DEFAULT threshold (50) so the
  // metric is valid + correct if interpolated verbatim — it then behaves as a
  // fixed "50+ scores" count, exactly the shape of the fixed fifties/hundreds
  // tallies above (note: runs >= 50 INCLUDES hundreds, unlike `fifties` which is
  // 50-99). `paramTemplate` is the same aggregate with a `{N}` token;
  // paramSqlExpression(metric, n) substitutes an integer N (see end of file).
  // `param` describes the drawer's numeric input. Counting total.
  {
    key: "innings_score_ge",
    label: "Innings Score ≥ N",
    shortLabel: "Inns ≥ N",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(CASE WHEN runs >= 50 THEN 1 ELSE 0 END)",
    paramTemplate: "SUM(CASE WHEN runs >= {N} THEN 1 ELSE 0 END)",
    param: { token: "{N}", default: 50, min: 0, step: 1, label: "runs" },
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
  },
  {
    key: "ducks",
    label: "Ducks",
    shortLabel: "Ducks",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(CASE WHEN runs = 0 AND dismissed = 1 THEN 1 ELSE 0 END)",
    higherIsBetter: false, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
  },
  {
    key: "not_outs",
    label: "Not Outs",
    shortLabel: "NO",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(CASE WHEN dismissed = 0 THEN 1 ELSE 0 END)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
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
    kind: "percent",
  },
  // ── Columns content rework Wave C (2026-08-08): the % ALTERNATE of `ducks` ────
  // Duck % = share of the batter's INNINGS that were ducks. The count↔% toggle
  // (columnsPicker.js COLUMN_TOGGLE_PAIRS) swaps `ducks` ⇄ this key in the visible
  // column list — it is never shown as its own picker row. NUMERATOR is byte-for-
  // byte the `ducks` count CASE (out for 0 → runs = 0 AND dismissed = 1), so the
  // count column and this % can never disagree; DENOMINATOR is innings (COUNT(*)),
  // the same denominator not_out_pct uses. Fewer ducks is better (mirrors `ducks`).
  {
    key: "duck_pct",
    label: "Duck %",
    shortLabel: "Duck%",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(CASE WHEN runs = 0 AND dismissed = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0)",
    higherIsBetter: false, format: "pct1",
    isPhaseMetric: null, zeroIsData: false,
    kind: "percent",
  },
  // ── Columns content rework Wave B (2026-08-08): new PLAIN counting metrics ────
  // Additive counting totals that surface, as their OWN columns, the sub-totals
  // the existing rate/% metrics already compute internally — so each new column and
  // its sibling rate/% can never disagree (each reuses the EXACT sub-expression):
  //   • Dismissals   = SUM(dismissed) — the DENOMINATOR of `average`
  //     (SUM(runs)/NULLIF(SUM(dismissed),0)), so Runs / Dismissals == Batting
  //     Average by construction. (matchup_batting has its own `dismissals`; this is
  //     the plain-batting sibling with the identical aggregate.)
  //   • Dot Balls    = SUM(dots) — the NUMERATOR of `dot_pct`.
  //   • Boundary Balls = SUM(fours_hit)+SUM(sixes_hit) — the boundary-ball count the
  //     boundary_pct / balls_per_boundary defs use (fours_hit/sixes_hit already
  //     apply the is_not_boundary rule in the view, so they ARE the boundary balls).
  //   • Boundary Runs  = 4*SUM(fours_hit)+6*SUM(sixes_hit) — the boundary-run
  //     numerator of boundary_runs_pct.
  // Counting totals: kind "total", additive, zeroIsData true (0 is a real value).
  {
    key: "dismissals",
    label: "Dismissals",
    shortLabel: "Dis",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(dismissed)",
    higherIsBetter: false, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
  },
  {
    key: "dot_balls",
    label: "Dot Balls",
    shortLabel: "Dots",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(dots)",
    higherIsBetter: false, // batting: fewer dots is better (mirrors dot_pct)
    format: "int",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
  },
  {
    key: "boundary_balls",
    label: "Boundary Balls",
    shortLabel: "Bdry Balls",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(fours_hit) + SUM(sixes_hit)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
  },
  {
    key: "boundary_runs",
    label: "Boundary Runs",
    shortLabel: "Bdry Runs",
    discipline: "batting",
    source: "innings",
    sqlExpression: "4 * SUM(fours_hit) + 6 * SUM(sixes_hit)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
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
    kind: "rate",
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
    kind: "rate",
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
    kind: "rate",
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
    kind: "rate",
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
    kind: "rate",
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
    kind: "rate",
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
    kind: "rate",
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
    kind: "rate",
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
    kind: "rate",
  },
  // ── Score composition / rotation (Wave 1) ────────────────────────────────
  // How a batter's runs and balls break down: boundary vs rotated runs, and how
  // often boundaries come. All read composition columns the batting_innings view
  // now carries (non_boundary_runs, ones/twos/threes, team_inns_balls) plus the
  // existing runs/balls_faced/fours_hit/sixes_hit. Running Strike Rate is the
  // strike rate on NON-boundary balls (source `non_boundary_sr`): non-boundary
  // runs over balls faced minus boundary balls (fours_hit + sixes_hit apply the
  // is_not_boundary rule, so they ARE the boundary balls).
  {
    key: "running_sr",
    label: "Non-Boundary Strike Rate",
    shortLabel: "NBSR",
    discipline: "batting",
    source: "innings",
    sqlExpression:
      "SUM(non_boundary_runs) * 100.0 / NULLIF(SUM(balls_faced) - SUM(fours_hit) - SUM(sixes_hit), 0)",
    higherIsBetter: true, format: "dec2",
    isPhaseMetric: null, zeroIsData: false,
    kind: "rate",
  },
  {
    key: "boundary_runs_pct",
    label: "% Runs from Boundaries",
    shortLabel: "Bdry Run%",
    discipline: "batting",
    source: "innings",
    // Share of RUNS (not balls) that came in boundary 4s/6s. Higher is treated
    // as better (Wave 1 brief), matching the existing Boundary % convention.
    sqlExpression: "(4 * SUM(fours_hit) + 6 * SUM(sixes_hit)) * 100.0 / NULLIF(SUM(runs), 0)",
    higherIsBetter: true, format: "pct1",
    isPhaseMetric: null, zeroIsData: false,
    kind: "percent",
  },
  {
    key: "runs_1s_pct",
    label: "% Runs in 1s",
    shortLabel: "1s Run%",
    discipline: "batting",
    source: "innings",
    // Share of runs scored in singles. Descriptive style split -> neutral.
    sqlExpression: "(1 * SUM(ones)) * 100.0 / NULLIF(SUM(runs), 0)",
    higherIsBetter: null, format: "pct1",
    isPhaseMetric: null, zeroIsData: false,
    kind: "percent",
  },
  {
    key: "runs_2s_pct",
    label: "% Runs in 2s",
    shortLabel: "2s Run%",
    discipline: "batting",
    source: "innings",
    sqlExpression: "(2 * SUM(twos)) * 100.0 / NULLIF(SUM(runs), 0)",
    higherIsBetter: null, format: "pct1",
    isPhaseMetric: null, zeroIsData: false,
    kind: "percent",
  },
  {
    key: "runs_3s_pct",
    label: "% Runs in 3s",
    shortLabel: "3s Run%",
    discipline: "batting",
    source: "innings",
    sqlExpression: "(3 * SUM(threes)) * 100.0 / NULLIF(SUM(runs), 0)",
    higherIsBetter: null, format: "pct1",
    isPhaseMetric: null, zeroIsData: false,
    kind: "percent",
  },
  // % Runs in 4s (run) / 5s / 6s (run) (filter-rejig Wave R1): the ran-runs and
  // all-run-fives extension of the existing % Runs in 1s/2s/3s family, read from
  // the composition columns the batting_innings view carries. nb_fours / nb_sixes
  // are the NON-boundary (ran) fours/sixes (is_not_boundary IS TRUE — the exact
  // complement of the boundary fours_hit/sixes_hit); `fives` are all-run 5s (a 5
  // off the bat is never a boundary). Descriptive style splits, so higherIsBetter
  // null, matching the 1s/2s/3s siblings. (Numerator carries the run-value factor
  // 4/5/6, like boundary_runs_pct; denominator SUM(runs) is NULLIF-guarded.)
  {
    key: "runs_4s_run_pct",
    label: "% Runs in 4s (run)",
    shortLabel: "4s-run%",
    discipline: "batting",
    source: "innings",
    sqlExpression: "(4 * SUM(nb_fours)) * 100.0 / NULLIF(SUM(runs), 0)",
    higherIsBetter: null, format: "pct1",
    isPhaseMetric: null, zeroIsData: false,
    kind: "percent",
  },
  {
    key: "runs_5s_pct",
    label: "% Runs in 5s",
    shortLabel: "5s Run%",
    discipline: "batting",
    source: "innings",
    sqlExpression: "(5 * SUM(fives)) * 100.0 / NULLIF(SUM(runs), 0)",
    higherIsBetter: null, format: "pct1",
    isPhaseMetric: null, zeroIsData: false,
    kind: "percent",
  },
  {
    key: "runs_6s_run_pct",
    label: "% Runs in 6s (run)",
    shortLabel: "6s-run%",
    discipline: "batting",
    source: "innings",
    sqlExpression: "(6 * SUM(nb_sixes)) * 100.0 / NULLIF(SUM(runs), 0)",
    higherIsBetter: null, format: "pct1",
    isPhaseMetric: null, zeroIsData: false,
    kind: "percent",
  },
  // % Runs in 4s (boundary) / 6s (boundary) (filter-rejig Wave R2): the BOUNDARY
  // halves of the 4s/6s % Runs split, completing the "% Runs in…" family the Wave
  // R1 note flagged for R2. fours_hit / sixes_hit are the BOUNDARY (is_not_boundary
  // IS NOT TRUE) fours/sixes — the exact complement of the ran nb_fours / nb_sixes
  // — so `4s-boundary + 4s-run` recovers all off-the-bat fours and, summed with the
  // 6s pair + 1s/2s/3s, the batting composition partitions runs. Each is a run-share
  // (numerator carries the 4/6 run-value factor, like boundary_runs_pct), and
  // 4s-boundary + 6s-boundary == the existing batting boundary_runs_pct (verified).
  // Descriptive style split, so higherIsBetter null, matching every % Runs sibling.
  {
    key: "runs_4s_boundary_pct",
    label: "% Runs in 4s (boundary)",
    shortLabel: "4s-bdry%",
    discipline: "batting",
    source: "innings",
    sqlExpression: "(4 * SUM(fours_hit)) * 100.0 / NULLIF(SUM(runs), 0)",
    higherIsBetter: null, format: "pct1",
    isPhaseMetric: null, zeroIsData: false,
    kind: "percent",
  },
  {
    key: "runs_6s_boundary_pct",
    label: "% Runs in 6s (boundary)",
    shortLabel: "6s-bdry%",
    discipline: "batting",
    source: "innings",
    sqlExpression: "(6 * SUM(sixes_hit)) * 100.0 / NULLIF(SUM(runs), 0)",
    higherIsBetter: null, format: "pct1",
    isPhaseMetric: null, zeroIsData: false,
    kind: "percent",
  },
  {
    key: "balls_per_four",
    label: "Balls per 4",
    shortLabel: "Bp4",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(balls_faced) * 1.0 / NULLIF(SUM(fours_hit), 0)",
    higherIsBetter: false, // fewer balls between fours is better
    format: "dec1",
    isPhaseMetric: null, zeroIsData: false,
    kind: "rate",
  },
  {
    key: "balls_per_six",
    label: "Balls per 6",
    shortLabel: "Bp6",
    discipline: "batting",
    source: "innings",
    sqlExpression: "SUM(balls_faced) * 1.0 / NULLIF(SUM(sixes_hit), 0)",
    higherIsBetter: false, // fewer balls between sixes is better
    format: "dec1",
    isPhaseMetric: null, zeroIsData: false,
    kind: "rate",
  },
  {
    key: "balls_faced_share",
    label: "Percentage of Balls Faced",
    shortLabel: "BF%",
    discipline: "batting",
    source: "innings",
    // Share of the batting side's balls this player faced (team_inns_balls is the
    // whole side's faced balls per innings). Plain batting only — the matchup
    // grain has no team-innings denominator.
    sqlExpression: "SUM(balls_faced) * 100.0 / NULLIF(SUM(team_inns_balls), 0)",
    higherIsBetter: null, format: "pct1",
    isPhaseMetric: null, zeroIsData: false,
    kind: "percent",
  },
  // R. Pos. column (owner decision 46, R3 Wave 5 polish): the player's
  // statistical MODE of batting_position — ties broken to the LOWEST position
  // — over the CORE scope (gender/format/date/team_type) ONLY, matching the
  // existing R. Pos. FILTER's own definition of "regular position" exactly
  // (filters.js's regularPositionsFilterActive block, commit e71530d) so the
  // column and the filter can never disagree about what a player's regular
  // position is. `sqlExpression` here is a placeholder never sent to DuckDB —
  // this ONE metric needs the live `state` (for the core-scope WHERE inside a
  // correlated CTE), which the generic "interpolate sqlExpression verbatim"
  // path can't express, so table.js's buildQuery special-cases this exact key
  // (see its regularPositionCteSql/wantsRPos). `discipline: "batting"` alone
  // is what keeps this batting-tables-only: bowling has no metric of this key,
  // and the matchup namespaces (matchup_batting/matchup_bowling) are separate
  // disciplines that never see it either — eligibleMetrics(ns, ...) filters by
  // exact discipline match, so it can only ever appear in the plain batting
  // column picker.
  {
    key: "r_pos",
    label: "Regular Batting Position",
    shortLabel: "R. Pos",
    columnTitle: "Regular position — where this player most often bats",
    discipline: "batting",
    source: "innings",
    sqlExpression: "__R_POS_PLACEHOLDER__", // never interpolated — see comment above
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    kind: "position",
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
    additive: true,
    kind: "total",
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
    kind: "percent",
  });
}

// ── Bowling ───────────────────────────────────────────────────────────────────
const BOWLING_METRICS = [
  {
    key: "matches",
    label: "Player Matches",
    shortLabel: "Mat",
    discipline: "bowling",
    source: "player_matches",
    sqlExpression: "COUNT(DISTINCT match_id)",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
  },
  {
    key: "innings",
    label: "Bowling Innings",
    shortLabel: "Bowl Inns",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "COUNT(*)",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
  },
  {
    // Overs bowled (Wave 0). Same SUM(balls) total as "Balls Bowled", displayed
    // in cricket O.B notation (format "overs" — see formatValue/labelForValue):
    // the stored + sorted value is the raw legal ball count, so sorting by Overs
    // sorts by balls (monotonic). DISPLAY ONLY — never a divisor/factor.
    key: "overs",
    label: "Overs",
    shortLabel: "Overs",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(balls)",
    higherIsBetter: null, format: "overs",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
  },
  {
    key: "runs_conceded",
    label: "Runs Conceded",
    shortLabel: "Runs Con",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(runs_conceded)",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
  },
  {
    key: "average",
    label: "Bowling Average",
    shortLabel: "Bowl Avg",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(runs_conceded) * 1.0 / NULLIF(SUM(wickets), 0)",
    higherIsBetter: false, // fewer runs per wicket is better
    format: "dec2",
    isPhaseMetric: null,
    zeroIsData: false,
    kind: "rate",
  },
  {
    key: "economy",
    label: "Economy",
    shortLabel: "Econ",
    discipline: "bowling",
    source: "innings",
    // Runs per over = runs / legal balls * 6. `balls` are legal balls; the
    // Hundred is NOT special-cased (SPEC).
    sqlExpression: "SUM(runs_conceded) * 6.0 / NULLIF(SUM(balls), 0)",
    higherIsBetter: false, format: "dec2",
    isPhaseMetric: null, zeroIsData: false,
    kind: "rate",
  },
  {
    key: "strike_rate",
    label: "Bowling Strike Rate",
    shortLabel: "Bowl SR",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(balls) * 1.0 / NULLIF(SUM(wickets), 0)",
    higherIsBetter: false, // fewer balls per wicket is better
    format: "dec2",
    isPhaseMetric: null,
    zeroIsData: false,
    kind: "rate",
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
    kind: "percent",
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
    kind: "percent",
  },
  // Boundary Run % (filter-rejig Wave R1): share of RUNS CONCEDED that came in
  // boundary 4s/6s off the bat — the bowling analog of the batting boundary_runs_
  // pct, and the run-share complement of the balls-based Boundary % Conceded just
  // above. Numerator uses the same fours_conceded/sixes_conceded columns (view
  // already applies the is_not_boundary boundary rule); denominator is
  // runs_conceded (runs_batter + noballs + wides, byes/leg-byes excluded), which
  // already includes any off-bat boundary struck off a no-ball, so numerator and
  // denominator stay consistent. Fewer boundary runs conceded is better, mirroring
  // the existing Boundary % Conceded convention. (Display rename to "Boundary Run
  // %" — batting + bowling together — is Wave R2, display-only; number unaffected.)
  {
    key: "boundary_runs_pct",
    label: "% Runs from Boundaries",
    shortLabel: "Bdry Run%",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "(4 * SUM(fours_conceded) + 6 * SUM(sixes_conceded)) * 100.0 / NULLIF(SUM(runs_conceded), 0)",
    higherIsBetter: false, format: "pct1",
    isPhaseMetric: null, zeroIsData: false,
    kind: "percent",
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
    additive: true,
    kind: "total",
  },
  // ── Columns content rework Wave C (2026-08-08): the % ALTERNATE of `maidens` ──
  // Maiden % = share of the OVERS the bowler bowled that were maiden overs =
  // 100 × maidens / overs, where overs = legal balls / 6 (the same over count the
  // `overs` column renders in O.B notation). Written 600 × maidens / balls, which
  // is algebraically 100 × maidens / (balls / 6) with the divide-by-zero guard on
  // balls (no balls bowled → no overs → NULL, never Infinity). NUMERATOR reuses the
  // `maidens` count, so the count column and this % never disagree. More maidens is
  // better (mirrors `maidens`). The count↔% toggle swaps `maidens` ⇄ this key.
  {
    key: "maiden_pct",
    label: "Maiden %",
    shortLabel: "Mdn%",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(maidens) * 600.0 / NULLIF(SUM(balls), 0)",
    higherIsBetter: true, format: "pct1",
    isPhaseMetric: null, zeroIsData: false,
    kind: "percent",
  },
  // Extras conceded (filter-rejig Wave R1): wide-runs and no-ball-runs the bowler
  // conceded, from the view's wides_runs / noball_runs columns (each a SUM of the
  // per-delivery wides / noballs extra INCLUDING boundary wides and multi-run
  // no-ball penalties — these are RUN totals, not delivery counts). Both are a
  // component of runs_conceded. higherIsBetter null (neutral volume total, like
  // runs_conceded/balls — an absolute extras count is confounded by how much the
  // bowler bowled; see report note if the owner wants "fewer is better" ranking).
  // The Wave R2 "Extras ▸ wides / no-balls" sub-filter keys off the `extras_`
  // prefix. Counting totals.
  {
    key: "extras_wides",
    label: "Wides",
    shortLabel: "Wd",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(wides_runs)",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
  },
  {
    key: "extras_noballs",
    label: "No-balls",
    shortLabel: "Nb",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(noball_runs)",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
  },
  // Wicket-haul milestone counts (Wave 0): innings in which the bowler took
  // exactly 4 (four-fer) vs 5-or-more (five-fer) BOWLER-CREDITED wickets — the
  // per-innings `wickets` column the view already carries (bowled/lbw/caught/
  // c&b/stumped/hit-wicket only, per SPEC §4.1). Exactly-4 and 5+ are disjoint,
  // so a 5-for is NOT also counted as a 4-for. Counting-total shape, mirroring
  // maidens.
  {
    key: "four_wicket_hauls",
    label: "Four-Wicket Hauls",
    shortLabel: "4W",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(CASE WHEN wickets = 4 THEN 1 ELSE 0 END)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
  },
  {
    key: "five_wicket_hauls",
    label: "Five-Wicket Hauls",
    shortLabel: "5W",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(CASE WHEN wickets >= 5 THEN 1 ELSE 0 END)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
  },
  // Wicket Hauls >= N (filter-rejig Wave R1): count of the bowler's innings with
  // at least N bowler-credited wickets — the parametrised generalisation of the
  // fixed exactly-4 (four_wicket_hauls) and 5-plus (five_wicket_hauls) tallies
  // above, kept ALONGSIDE them (additive brief; any UI consolidation is later).
  // `wickets` is already the SPEC §4.1 bowler-credited count (bowled/lbw/caught/
  // c&b/stumped/hit-wicket only). Same PARAMETRISED contract as Innings Score >=
  // N: DEFAULT threshold (4) baked into sqlExpression so verbatim interpolation
  // stays valid + correct; `paramTemplate` + paramSqlExpression(metric, n) inject
  // a user-supplied N in Wave R2. Note wickets >= 5 reproduces five_wicket_hauls,
  // and wickets >= 4 = four_wicket_hauls + five_wicket_hauls (verified). Counting
  // total.
  {
    key: "wicket_hauls_ge",
    label: "Wicket Hauls ≥ N",
    shortLabel: "Hauls ≥ N",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(CASE WHEN wickets >= 4 THEN 1 ELSE 0 END)",
    paramTemplate: "SUM(CASE WHEN wickets >= {N} THEN 1 ELSE 0 END)",
    param: { token: "{N}", default: 4, min: 1, step: 1, label: "wickets" },
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
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
    kind: "rate",
  },
  {
    key: "best",
    label: "Best Bowling",
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
    kind: "peak",
    // Wave A2 (item 2): drives the TWO-box stat condition "≥ W wickets for ≤ R
    // runs". A display/behaviour flag only — the drawer renders two inputs and
    // suppresses the operator select, and table.js's conditionToHaving compiles
    // `sortExpression >= (W*1000 - R)` (the numeric peak rank, NOT the "W-R"
    // display string). No aggregation string above changes.
    conditionInput: "bowlingFigures",
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    kind: "rate",
  },
  {
    key: "mid_economy",
    label: "Middle Overs Economy",
    shortLabel: "Mid Econ",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(mid_runs_conceded) * 6.0 / NULLIF(SUM(mid_balls), 0)",
    higherIsBetter: false, format: "dec2",
    isPhaseMetric: "t20", zeroIsData: false,
    kind: "rate",
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
    kind: "rate",
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
    additive: true,
    kind: "total",
  },
  {
    key: "mid_wickets",
    label: "Middle Overs Wickets",
    shortLabel: "Mid Wkts",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(mid_wickets)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: "t20", zeroIsData: true,
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    kind: "rate",
  },
  {
    key: "odi_mid_economy",
    label: "ODI Middle Overs Economy",
    shortLabel: "ODI Mid Econ",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(odi_mid_runs_conceded) * 6.0 / NULLIF(SUM(odi_mid_balls), 0)",
    higherIsBetter: false, format: "dec2",
    isPhaseMetric: "odi", zeroIsData: false,
    kind: "rate",
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
    kind: "rate",
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
    additive: true,
    kind: "total",
  },
  {
    key: "odi_mid_wickets",
    label: "ODI Middle Overs Wickets",
    shortLabel: "ODI Mid Wkts",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(odi_mid_wickets)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: "odi", zeroIsData: true,
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
  },
  // ── Columns content rework Wave B (2026-08-08): plain BOWLING counting metrics ──
  // The bowling analogues of the batting Wave B counts — a bowler's boundaries and
  // dot balls conceded — today available only in the matchup_bowling namespace
  // (fours_conceded / sixes_conceded) or as a %'s numerator:
  //   • 4s Conceded = SUM(fours_conceded) — matchup_bowling's aggregate, as plain bowling.
  //   • 6s Conceded = SUM(sixes_conceded) — matchup_bowling's aggregate, as plain bowling.
  //   • Dot Balls Conceded = SUM(dots) — the NUMERATOR of the bowling `dot_pct`.
  // fours_conceded/sixes_conceded already apply the is_not_boundary boundary rule
  // in the view. Counting totals: kind "total", additive, zeroIsData true.
  {
    key: "fours_conceded",
    label: "4s Conceded",
    shortLabel: "4s Con",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(fours_conceded)",
    higherIsBetter: false, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
  },
  {
    key: "sixes_conceded",
    label: "6s Conceded",
    shortLabel: "6s Con",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(sixes_conceded)",
    higherIsBetter: false, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
  },
  {
    key: "dot_balls_conceded",
    label: "Dot Balls Conceded",
    shortLabel: "Dots Con",
    discipline: "bowling",
    source: "innings",
    sqlExpression: "SUM(dots)",
    higherIsBetter: true, // bowling: MORE dots is better (mirrors dot_pct)
    format: "int",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
  },
];

// ── Fielding + Impact (fielding rebuild) ────────────────────────────────────
// Player-level fielding (catches / stumpings / run-outs / dismissals effected)
// and match impact (Player-of-the-Match count). NOT a batting or bowling stat.
//
// Fielding (catches/stumpings/run-outs/dismissals-effected) now aggregate the
// EVENT-GRAIN `fielding` view (one row per wicket-credit, from fielding_events.
// parquet) — so they honor the FULL shared scope: match context + fielding_team
// + OPPOSITION + event + venue + profile, plus their own dims (dismissed-batter
// position/kind/phase via fielding conditions). buildQuery (src/table.js) LEFT
// JOINs a per-fielder pre-aggregated `fielding_cte` (ONE row per fielder over
// the scoped fielding_events, substitutes excluded by default) onto the
// batting/bowling GROUP BY; each value is constant across a player's group and
// projected with MAX() — the same shape as the R. Pos. join. The CTE is one row
// per player, so the join never multiplies innings rows → every existing
// aggregate stays byte-identical.
//
// Player-of-the-Match stays sourced from `player_matches` (source
// "player_matches") — it is genuinely per-match, not a fielding event — and is
// surfaced via a parallel per-player `pom_cte` LEFT JOIN (MAX(pom_cte.…)).
//
// Defined once and pushed into BOTH disciplines (owner: "available in BOTH the
// batting and bowling leaderboards"). `section` "fielding"/"impact" places them
// under those sub-headers in the column picker and the "+ Add condition…" list;
// higherIsBetter true (more dismissals / awards ranks better).
const FIELDING_METRIC_SPECS = [
  { key: "catches", label: "Catches", shortLabel: "Ct", section: "fielding",
    source: "fielding_events", sqlExpression: "MAX(fielding_cte.catches)" },
  // Caught & bowled (Wave R2d): the c&b-only subset of `catches` (which still
  // folds c&b in, unchanged). A distinct fielding count so "Fielding Wicket Type ▸
  // Caught & bowled" can filter on c&b alone. Reads the new fielding_cte.
  // caught_and_bowled column (buildFieldingCteSql), projected with MAX() like its
  // three siblings. Additive: no existing catch/stumping/run-out number changes.
  { key: "caught_and_bowled", label: "Caught & bowled", shortLabel: "C&B", section: "fielding",
    source: "fielding_events", sqlExpression: "MAX(fielding_cte.caught_and_bowled)" },
  { key: "stumpings", label: "Stumpings", shortLabel: "St", section: "fielding",
    source: "fielding_events", sqlExpression: "MAX(fielding_cte.stumpings)" },
  { key: "run_outs", label: "Run-outs", shortLabel: "RO", section: "fielding",
    source: "fielding_events", sqlExpression: "MAX(fielding_cte.run_outs)" },
  { key: "dismissals_effected", label: "Fielding Dismissals", shortLabel: "F. Wkts", section: "fielding",
    source: "fielding_events",
    sqlExpression: "MAX(fielding_cte.catches + fielding_cte.stumpings + fielding_cte.run_outs)" },
  { key: "player_of_match", label: "Player of the Match", shortLabel: "PoM", section: "impact",
    source: "player_matches", sqlExpression: "MAX(pom_cte.player_of_match)" },
  // PotM Count (filter-rejig Wave R2b): the FILTERABLE count of Player-of-the-Match
  // awards, placed in the "+ Add condition" Player Profile group (the old
  // player_of_match def above stays as a COLUMN but is no longer a filter). It reads
  // the SAME per-player `pom_cte`, whose ONLY column `player_of_match` is ALREADY the
  // per-player SUM of the 0/1 PotM flag (buildPomCteSql: `SUM(player_of_match)`), i.e.
  // the award COUNT. So the metric's job is only to PROJECT that constant out of the
  // batting/bowling GROUP BY — done with MAX() (the same functionally-dependent-join
  // projection R. Pos. / fielding_cte / player_of_match all use). A literal outer
  // SUM(pom_cte.player_of_match) would MULTIPLY the count by the batter's innings-row
  // count (wrong), so the "SUM of the flag" the count needs is the one INSIDE the CTE,
  // not the outer projection. Value == player_of_match exactly (SA Yadav = 5 PotM,
  // independently verified). isPomMetric picks it up (source player_matches, key !=
  // matches), so it drives HAVING via the pom_cte join with no query-builder change.
  { key: "potm_count", label: "Player of the Match Count", shortLabel: "PotM", section: "impact",
    source: "player_matches", sqlExpression: "MAX(pom_cte.player_of_match)" },
];
for (const disc of ["batting", "bowling"]) {
  for (const f of FIELDING_METRIC_SPECS) {
    (disc === "batting" ? BATTING_METRICS : BOWLING_METRICS).push({
      key: f.key,
      label: f.label,
      shortLabel: f.shortLabel,
      discipline: disc,
      source: f.source,
      section: f.section,
      sqlExpression: f.sqlExpression,
      higherIsBetter: true, format: "int",
      isPhaseMetric: null, zeroIsData: true,
      additive: true,
      kind: "total",
    });
  }
}

// ── Per-match fielding (columns content rework Wave C, 2026-08-08) ────────────
// The PER-MATCH alternate of each fielding COUNT (owner: fielding toggles count ⇄
// per-match, NOT count ⇄ %). Per-match = the fielding count ÷ the player's Player
// Matches — a rate, so kind "rate" / format dec2 / zeroIsData false. The numerator
// reuses the EXACT fielding_cte expression of its count sibling (so count and
// per-match can never disagree); the denominator is a per-player match count from a
// dedicated `pmatch_cte` over player_matches (MAX(pmatch_cte.match_count) — the same
// COUNT(DISTINCT match_id) core scope the Player Matches column / pom_cte use, so a
// fielder's per-match reconciles with their Matches column in the un-sliced
// leaderboard). `perMatch: true` is the flag table.js/charts.js gate the pmatch_cte
// build+join on (like source "result" gates result_cte); source stays
// "fielding_events" so the fielding_cte join lights up too. Only the count/per-match
// TOGGLE surfaces these (COLUMN_TOGGLE_PAIRS) — never their own picker row.
const PER_MATCH_FIELDING_SPECS = FIELDING_METRIC_SPECS.filter((f) => f.section === "fielding");
for (const disc of ["batting", "bowling"]) {
  for (const f of PER_MATCH_FIELDING_SPECS) {
    // f.sqlExpression is `MAX(fielding_cte.<…>)`; divide that COUNT by the player's
    // match count, NULLIF-guarded (no matches → NULL, never Infinity).
    const perMatchExpr = `(${f.sqlExpression}) * 1.0 / NULLIF(MAX(pmatch_cte.match_count), 0)`;
    (disc === "batting" ? BATTING_METRICS : BOWLING_METRICS).push({
      key: `${f.key}_per_match`,
      label: `${f.label} per Match`,
      shortLabel: `${f.shortLabel}/M`,
      discipline: disc,
      source: "fielding_events",
      section: "fielding",
      perMatch: true,
      sqlExpression: perMatchExpr,
      higherIsBetter: true, format: "dec2",
      isPhaseMetric: null, zeroIsData: false,
      kind: "rate",
    });
  }
}

// ── Result family (columns content rework Wave B, 2026-08-08) ────────────────
// Per-player counts of MATCH OUTCOMES relative to the player's own team — Matches
// Won / Lost / Tied / No-result and Toss Won. Like Player-of-the-Match, these are
// whole-MATCH facts, not innings aggregates, so they live in a per-player CTE
// (`result_cte`, built by table.js's buildResultCteSql over player_matches +
// matches) LEFT-JOINed onto the batting/bowling GROUP BY and projected with MAX()
// (one row per player, constant across the group — the same functionally-dependent
// -join shape pom_cte/fielding_cte use). A DEDICATED `source: "result"` (NOT
// "player_matches", which isPomMetric would claim, routing them through the wrong
// CTE) makes table.js gate + join result_cte only when a Result column/condition
// is shown — so with none, the emitted SQL is byte-identical.
//
// The five outcome predicates INSIDE result_cte are the SAME fields + comparisons
// the "Match Result" / "Toss Result" FILTERS use (filters.js buildMatchContext-
// Clauses): team = match_winner (won) / match_winner IS NOT NULL AND <> team
// (lost) / result_type = 'tie' (tied) / result_type = 'no result' / team =
// toss_winner (toss won). So a Result column reconciles with the matching filter
// by construction. `section: "impact"` routes them to the Match dropdown right
// after Player of the Match Count (the same rule potm_count uses). Defined once
// and pushed into BOTH disciplines (a match fact is discipline-agnostic, exactly
// like PoM). Counting totals: kind "total", additive, zeroIsData true.
const RESULT_METRIC_SPECS = [
  { key: "res_won", label: "Matches Won", shortLabel: "Won", col: "won", higherIsBetter: true,
    pctLabel: "Win %", pctShort: "Win%", pctHigherIsBetter: true },
  { key: "res_lost", label: "Matches Lost", shortLabel: "Lost", col: "lost", higherIsBetter: false,
    pctLabel: "Loss %", pctShort: "Loss%", pctHigherIsBetter: false },
  { key: "res_tied", label: "Matches Tied", shortLabel: "Tied", col: "tied", higherIsBetter: null,
    pctLabel: "Tie %", pctShort: "Tie%", pctHigherIsBetter: null },
  { key: "res_no_result", label: "No Result", shortLabel: "NR", col: "no_result", higherIsBetter: null,
    pctLabel: "No Result %", pctShort: "NR%", pctHigherIsBetter: null },
  { key: "res_toss_won", label: "Toss Won", shortLabel: "Toss", col: "toss_won", higherIsBetter: null,
    pctLabel: "Toss Win %", pctShort: "Toss%", pctHigherIsBetter: null },
];
for (const disc of ["batting", "bowling"]) {
  for (const r of RESULT_METRIC_SPECS) {
    (disc === "batting" ? BATTING_METRICS : BOWLING_METRICS).push({
      key: r.key,
      label: r.label,
      shortLabel: r.shortLabel,
      discipline: disc,
      source: "result",
      section: "impact",
      sqlExpression: `MAX(result_cte.${r.col})`,
      higherIsBetter: r.higherIsBetter, format: "int",
      isPhaseMetric: null, zeroIsData: true,
      additive: true,
      kind: "total",
    });
    // ── Columns content rework Wave C: the % ALTERNATE of each Result count ────
    // Result % = the outcome count ÷ the player's TOTAL matches × 100. Denominator
    // is result_cte's `total` column (COUNT(DISTINCT match_id) — the same Player
    // Matches count the counts partition, added by buildResultCteSql for this
    // wave), NULLIF-guarded. NUMERATOR reuses the count's own result_cte column, so
    // the count and its % never disagree. source "result" routes it through the
    // SAME result_cte join. Only the count/% toggle surfaces these — never their
    // own picker row.
    (disc === "batting" ? BATTING_METRICS : BOWLING_METRICS).push({
      key: `${r.key}_pct`,
      label: r.pctLabel,
      shortLabel: r.pctShort,
      discipline: disc,
      source: "result",
      section: "impact",
      sqlExpression: `MAX(result_cte.${r.col}) * 100.0 / NULLIF(MAX(result_cte.total), 0)`,
      higherIsBetter: r.pctHigherIsBetter, format: "pct1",
      isPhaseMetric: null, zeroIsData: false,
      kind: "percent",
    });
  }
}

// ── Per-column count/% (+ count/per-match) toggle pairings (Wave C) ────────────
// The leaderboard's Columns picker (columnsPicker.js) renders each COUNT key below
// as a single row whose value can be toggled between the count metric and its
// paired ALTERNATE (% for most, per-match for fielding). Default = count. Keyed by
// PLAIN discipline (batting/bowling): `dot_pct` is a shared key with a different
// meaning per discipline, so the pair (dot_balls / dot_balls_conceded ⇄ dot_pct)
// must be resolved within a namespace. `mode` is the alternate's form:
//   "pct"      — count ⇄ % (share; e.g. Boundary Balls ⇄ Boundary %)
//   "permatch" — count ⇄ per-match (fielding only; e.g. Catches ⇄ Catches per Match)
// Result + fielding pairs are derived from their specs so this can never drift from
// the metric catalogue. The matchup namespaces have NO entry (no toggle there — Vs
// mode keeps its pre-Wave-C layout). Every `alt` key is a real metric added above.
const _RESULT_PAIRS = RESULT_METRIC_SPECS.map((r) => ({ count: r.key, alt: `${r.key}_pct`, mode: "pct" }));
const _FIELDING_PAIRS = PER_MATCH_FIELDING_SPECS.map((f) => ({
  count: f.key, alt: `${f.key}_per_match`, mode: "permatch",
}));
export const COLUMN_TOGGLE_PAIRS = {
  batting: [
    { count: "boundary_balls", alt: "boundary_pct", mode: "pct" },
    { count: "boundary_runs", alt: "boundary_runs_pct", mode: "pct" },
    { count: "dot_balls", alt: "dot_pct", mode: "pct" },
    { count: "not_outs", alt: "not_out_pct", mode: "pct" },
    { count: "ducks", alt: "duck_pct", mode: "pct" },
    ..._RESULT_PAIRS,
    ..._FIELDING_PAIRS,
  ],
  bowling: [
    { count: "maidens", alt: "maiden_pct", mode: "pct" },
    { count: "dot_balls_conceded", alt: "dot_pct", mode: "pct" },
    ..._RESULT_PAIRS,
    ..._FIELDING_PAIRS,
  ],
};

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
    key: "matches",
    label: "Matches",
    shortLabel: "Mat",
    discipline: "matchup_batting",
    source: "matchup",
    // Decision 47(c): matches in which the batter faced this bucket. The plain
    // "matches" metric reads player_matches (source:"player_matches") because a
    // player can appear in a match without batting; here every matchup_batting
    // row already IS a faced-bucket record, so COUNT(DISTINCT match_id)
    // FILTER'd on the bucket (buildMatchupQuery) is the honest in-bucket match
    // count — the same "matches within the slice" rule decision 28 set for
    // splits. vsTableOnly: leaderboard Vs table only (task scope).
    sqlExpression: "COUNT(DISTINCT match_id)",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
    vsTableOnly: true,
  },
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
  },
  {
    key: "high_score",
    label: "High Score",
    shortLabel: "HS",
    discipline: "matchup_batting",
    source: "matchup",
    // Decision 47(c): PEAK single-innings run tally vs this bucket. Because
    // buildMatchupQuery's step-1 GROUP BY (id, name) has already collapsed
    // innings, this is NOT a step-1 aggregate — it's computed in a joined
    // pre-aggregation (runs SUM'd per (id, match, innings) FILTER'd on the
    // bucket, then MAX per player). kind:"peak" routes it there via the
    // peakInner/peakOuter recipe; sqlExpression is a placeholder NEVER sent to
    // DuckDB (mirroring composition's __COMPOSITION__). Proven live: SA Yadav
    // High Score vs Spin = 47.
    sqlExpression: "__PEAK__",
    peakInner: "SUM(runs) AS __pk_hs",
    peakOuter: "MAX(__pk_hs)",
    higherIsBetter: true, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    kind: "peak",
    vsTableOnly: true,
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
    kind: "rate",
  },
  {
    key: "average",
    label: "Batting Average",
    shortLabel: "Avg",
    discipline: "matchup_batting",
    source: "matchup",
    // Denominator is bowler-credited dismissals only (decision 23) — the
    // view's `dismissals` column already excludes run-outs etc.
    sqlExpression: "SUM(runs) * 1.0 / NULLIF(SUM(dismissals), 0)",
    higherIsBetter: true, format: "dec2",
    isPhaseMetric: null, zeroIsData: false,
    kind: "rate",
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
    additive: true,
    kind: "total",
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
    kind: "percent",
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
    kind: "percent",
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    kind: "rate",
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
    kind: "rate",
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    kind: "rate",
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
    kind: "rate",
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
    kind: "rate",
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
    kind: "rate",
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
    kind: "rate",
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
    kind: "rate",
  },
  // ── Score composition / rotation vs this bucket (Wave 1) ──────────────────
  // Same family as the plain batting namespace's composition metrics, computed
  // at the matchup grain over the matchup_batting view's OWN columns (it now
  // carries non_boundary_runs / ones / twos / threes / fours_hit / sixes_hit /
  // balls_faced / runs at matchup grain). Balls-Faced Share is intentionally
  // absent here (plain batting only — no team-innings denominator at this grain).
  // NOTE: the composition columns land via the Wave 1 pipeline extension and are
  // not yet on R2 — defined here so the restricted picker/vocabulary is ready
  // when they arrive (same posture as the phase/dis_* matchup metrics above).
  {
    key: "running_sr",
    label: "Running Strike Rate",
    shortLabel: "Run SR",
    discipline: "matchup_batting",
    source: "matchup",
    sqlExpression:
      "SUM(non_boundary_runs) * 100.0 / NULLIF(SUM(balls_faced) - SUM(fours_hit) - SUM(sixes_hit), 0)",
    higherIsBetter: true, format: "dec2",
    isPhaseMetric: null, zeroIsData: false,
    kind: "rate",
  },
  {
    key: "boundary_runs_pct",
    label: "% Runs from Boundaries",
    shortLabel: "Bdry Run%",
    discipline: "matchup_batting",
    source: "matchup",
    sqlExpression: "(4 * SUM(fours_hit) + 6 * SUM(sixes_hit)) * 100.0 / NULLIF(SUM(runs), 0)",
    higherIsBetter: true, format: "pct1",
    isPhaseMetric: null, zeroIsData: false,
    kind: "percent",
  },
  {
    key: "runs_1s_pct",
    label: "% Runs in 1s",
    shortLabel: "1s Run%",
    discipline: "matchup_batting",
    source: "matchup",
    sqlExpression: "(1 * SUM(ones)) * 100.0 / NULLIF(SUM(runs), 0)",
    higherIsBetter: null, format: "pct1",
    isPhaseMetric: null, zeroIsData: false,
    kind: "percent",
  },
  {
    key: "runs_2s_pct",
    label: "% Runs in 2s",
    shortLabel: "2s Run%",
    discipline: "matchup_batting",
    source: "matchup",
    sqlExpression: "(2 * SUM(twos)) * 100.0 / NULLIF(SUM(runs), 0)",
    higherIsBetter: null, format: "pct1",
    isPhaseMetric: null, zeroIsData: false,
    kind: "percent",
  },
  {
    key: "runs_3s_pct",
    label: "% Runs in 3s",
    shortLabel: "3s Run%",
    discipline: "matchup_batting",
    source: "matchup",
    sqlExpression: "(3 * SUM(threes)) * 100.0 / NULLIF(SUM(runs), 0)",
    higherIsBetter: null, format: "pct1",
    isPhaseMetric: null, zeroIsData: false,
    kind: "percent",
  },
  {
    key: "balls_per_four",
    label: "Balls per Four",
    shortLabel: "BP4",
    discipline: "matchup_batting",
    source: "matchup",
    sqlExpression: "SUM(balls_faced) * 1.0 / NULLIF(SUM(fours_hit), 0)",
    higherIsBetter: false, format: "dec1",
    isPhaseMetric: null, zeroIsData: false,
    kind: "rate",
  },
  {
    key: "balls_per_six",
    label: "Balls per Six",
    shortLabel: "BP6",
    discipline: "matchup_batting",
    source: "matchup",
    sqlExpression: "SUM(balls_faced) * 1.0 / NULLIF(SUM(sixes_hit), 0)",
    higherIsBetter: false, format: "dec1",
    isPhaseMetric: null, zeroIsData: false,
    kind: "rate",
  },
  // ── Composition columns (Coverage-breakdown wave) ─────────────────────────
  // Each = (that bowling_group's UNFILTERED balls faced) ÷ (the player's TOTAL
  // balls faced in scope) × 100 — a DESCRIPTIVE style-mix percentage that is
  // UN-FILTERED by the selected Vs bucket (it describes the whole faced
  // composition, exactly like the coverage figure it replaces), so it must NOT
  // go through the per-bucket FILTER path the other matchup metrics take.
  // `kind: "composition"` (a dedicated value, like r_pos's "position") marks
  // these for special handling: `sqlExpression` is a placeholder NEVER
  // interpolated — table.js's buildMatchupQuery computes them from unfiltered
  // per-group ball partials windowed per player over the '(unmapped)'-aware
  // coverage denominator (see that function). `compositionGroup` is the exact
  // bowling_group value each column measures. Table-only: the graph never sees
  // the matchup namespaces, and advanced.js excludes kind "composition" from
  // the stat-condition picker. zeroIsData:true so 0% (a player who faced no
  // spin) is shown as "0.0%", never hidden; higherIsBetter:null (neutral).
  // The three per row partition the player's balls faced, so they sum to 100%.
  {
    key: "comp_pace",
    label: "Pace BF %",
    shortLabel: "Pace BF %",
    discipline: "matchup_batting",
    source: "matchup",
    compositionGroup: "Pace",
    sqlExpression: "__COMPOSITION__", // never interpolated — see comment above
    higherIsBetter: null, format: "pct1",
    isPhaseMetric: null, zeroIsData: true,
    kind: "composition",
  },
  {
    key: "comp_spin",
    label: "Spin BF %",
    shortLabel: "Spin BF %",
    discipline: "matchup_batting",
    source: "matchup",
    compositionGroup: "Spin",
    sqlExpression: "__COMPOSITION__",
    higherIsBetter: null, format: "pct1",
    isPhaseMetric: null, zeroIsData: true,
    kind: "composition",
  },
  {
    key: "comp_uncat",
    label: "Uncategorised BF %",
    shortLabel: "Uncat %",
    discipline: "matchup_batting",
    source: "matchup",
    compositionGroup: "(unmapped)",
    sqlExpression: "__COMPOSITION__",
    higherIsBetter: null, format: "pct1",
    isPhaseMetric: null, zeroIsData: true,
    kind: "composition",
  },
];
// Table COLUMN HEADER shows shortLabel (table.js headerCellHTML); the Columns
// picker + long-form uses show `label` (table.js:2229). The Uncategorised
// composition columns keep the full descriptive `label` but shorten the header
// to "Uncat %" so it doesn't crowd the Vs table. (Set once here, not in table.js.)

const MATCHUP_BOWLING_METRICS = [
  {
    key: "matches",
    label: "Matches",
    shortLabel: "Mat",
    discipline: "matchup_bowling",
    source: "matchup",
    // Decision 47(c): matches in which the bowler bowled to this batting-hand
    // bucket. Same rationale as matchup_batting's "matches" above — a plain
    // matchup aggregate (COUNT(DISTINCT match_id) FILTER'd on the bucket), not
    // the player_matches source the plain namespace uses. vsTableOnly:
    // leaderboard Vs table only (task scope).
    sqlExpression: "COUNT(DISTINCT match_id)",
    higherIsBetter: null, format: "int",
    isPhaseMetric: null, zeroIsData: true,
    additive: true,
    kind: "total",
    vsTableOnly: true,
  },
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    kind: "rate",
  },
  {
    key: "average",
    label: "Bowling Average",
    shortLabel: "Avg",
    discipline: "matchup_bowling",
    source: "matchup",
    sqlExpression: "SUM(runs_conceded) * 1.0 / NULLIF(SUM(wickets), 0)",
    higherIsBetter: false, format: "dec2",
    isPhaseMetric: null, zeroIsData: false,
    kind: "rate",
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
    kind: "rate",
  },
  {
    key: "best",
    label: "Best Bowling (Innings)",
    shortLabel: "BBI",
    discipline: "matchup_bowling",
    source: "matchup",
    // Decision 47(c): PEAK single-innings figures vs this batting hand, "W-R"
    // (most wickets, then fewest runs) — the SAME display + rank rule as the
    // plain bowling `best` metric. A per-innings PEAK, so (like high_score) it
    // is NOT a step-1 aggregate: buildMatchupQuery pre-aggregates wickets +
    // runs_conceded per (id, match, innings) FILTER'd on the bucket, then
    // arg_max / MAX per player (kind:"peak"; peakInner/peakOuter/peakOuterSort
    // recipe). Both sqlExpression AND sortExpression are placeholders NEVER sent
    // to DuckDB — the peak CTE emits `best` (display "W-R") and `best__sort`
    // (numeric rank). sortExpression must be TRUTHY so table.js's sortValue()
    // reads the __sort shadow column for this str-format metric (exactly as
    // plain `best` does).
    sqlExpression: "__PEAK__",
    sortExpression: "__PEAK_SORT__",
    peakInner: "SUM(wickets) AS __pk_w, SUM(runs_conceded) AS __pk_r",
    peakOuter:
      "arg_max(CAST(__pk_w AS INTEGER) || '-' || CAST(__pk_r AS INTEGER), __pk_w * 1000 - __pk_r)",
    peakOuterSort: "MAX(__pk_w * 1000 - __pk_r)",
    higherIsBetter: true, format: "str",
    isPhaseMetric: null, zeroIsData: true,
    kind: "peak",
    // Wave A2 (item 2, Vs): same TWO-box condition as the plain `best`. In
    // matchup mode conditionToHaving compiles against the peak CTE's numeric
    // rank column `peak.best__sort` (= peakOuterSort) — not this placeholder
    // sqlExpression/sortExpression. Flag only; no aggregation string changes.
    conditionInput: "bowlingFigures",
    vsTableOnly: true,
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
    kind: "percent",
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
    kind: "percent",
  },
  // Boundary Run % (matchup_bowling) — Wave R2d. The removal audit found the
  // boundary_runs_pct replacement for the deleted balls-based boundary_pct_conceded
  // was added to batting / bowling / matchup_batting but NOT matchup_bowling, so
  // bowling-vs-a-batting-hand lost boundary-concession filtering. This restores it:
  // identical formula to the plain-bowling def — share of RUNS CONCEDED that came in
  // boundary 4s/6s off the bat. Denominator runs_conceded (runs_batter + noballs +
  // wides, byes/leg-byes excluded) is NULLIF-guarded; fewer is better (matches the
  // Boundary % Conceded convention above). Placed in the matchup-bowling Detailed
  // Stats palette group (drawer.js line already calls leafMetric("boundary_runs_pct")
  // in the shared Bowling · Detailed group — it resolves here once this def exists).
  {
    key: "boundary_runs_pct",
    label: "% Runs from Boundaries",
    shortLabel: "Bdry Run%",
    discipline: "matchup_bowling",
    source: "matchup",
    sqlExpression: "(4 * SUM(fours_conceded) + 6 * SUM(sixes_conceded)) * 100.0 / NULLIF(SUM(runs_conceded), 0)",
    higherIsBetter: false, format: "pct1",
    isPhaseMetric: null, zeroIsData: false,
    kind: "percent",
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    kind: "rate",
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    kind: "rate",
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
    kind: "rate",
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
    kind: "rate",
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    kind: "rate",
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
    kind: "rate",
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
    kind: "rate",
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
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
    additive: true,
    kind: "total",
  },
  // ── Composition columns (Coverage-breakdown wave) ─────────────────────────
  // Bowling analogue of matchup_batting's comp_* metrics above (see that block
  // for the full contract): each = (that batting_hand's UNFILTERED balls
  // bowled) ÷ (the player's TOTAL balls bowled in scope) × 100 — a descriptive
  // hand-mix percentage, UN-FILTERED by the selected Vs bucket, computed by
  // table.js's buildMatchupQuery from unfiltered per-hand ball partials. The
  // three per row partition balls bowled, so they sum to 100%.
  {
    key: "comp_rhb",
    label: "RHB %",
    shortLabel: "RHB %",
    discipline: "matchup_bowling",
    source: "matchup",
    compositionGroup: "Right-hand bat",
    sqlExpression: "__COMPOSITION__", // never interpolated — see comment above
    higherIsBetter: null, format: "pct1",
    isPhaseMetric: null, zeroIsData: true,
    kind: "composition",
  },
  {
    key: "comp_lhb",
    label: "LHB %",
    shortLabel: "LHB %",
    discipline: "matchup_bowling",
    source: "matchup",
    compositionGroup: "Left-hand bat",
    sqlExpression: "__COMPOSITION__",
    higherIsBetter: null, format: "pct1",
    isPhaseMetric: null, zeroIsData: true,
    kind: "composition",
  },
  {
    key: "comp_uncat",
    label: "Uncategorised %",
    shortLabel: "Uncat %",
    discipline: "matchup_bowling",
    source: "matchup",
    compositionGroup: "(unmapped)",
    sqlExpression: "__COMPOSITION__",
    higherIsBetter: null, format: "pct1",
    isPhaseMetric: null, zeroIsData: true,
    kind: "composition",
  },
];

const METRICS = [...BATTING_METRICS, ...BOWLING_METRICS, ...MATCHUP_BATTING_METRICS, ...MATCHUP_BOWLING_METRICS];

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
  if (discipline) {
    const hit = _byDisciplineKey.get(`${discipline}:${key}`);
    if (hit) return hit;
    // Columns content rework D1/D2/D3 (2026-08-08): composed dimension×metric keys
    // are DYNAMIC virtual metrics — never in the static catalogue — whose
    // sqlExpression is rebuilt on the fly. Five schemes share this ONE fallback:
    //   • ph__<phase>__<base>  (D1) — phase-prefixed precomputed components.
    //   • bl__<bucket>__<base> (D2) — faced-ball-bucket precomputed components.
    //   • in__<iToken>__<base> (D2) — conditional aggregation over innings_number.
    //   • rs__<source>__<axis> (D3) — run-source run-total / % of runs (batting).
    //   • wt__<type>__<axis>   (D3) — wicket-type count / % (both disciplines).
    //   • isr__/wh__<op>__<v>  (D4) — parametric threshold count (op ∈ ge/le/eq/bt):
    //     Innings Score Range (batting) / Wicket Haul (bowling).
    // Resolve them HERE so the leaderboard's buildQuery inningsMetrics path (which
    // calls getMetric) projects them through the NORMAL selectParts loop with NO
    // query-builder change. Byte-identical for every catalogued key (the map hit
    // returns first); each resolver returns null for keys of another prefix, for
    // plain/cross keys, and for the matchup disciplines, so those callers are
    // unchanged (same `?? null` result as before).
    return (
      resolveComposedPhaseMetric(key, discipline) ??
      resolveComposedBallMetric(key, discipline) ??
      resolveComposedInningsMetric(key, discipline) ??
      resolveComposedRunSourceMetric(key, discipline) ??
      resolveComposedWicketTypeMetric(key, discipline) ??
      resolveComposedParamMetric(key, discipline)
    );
  }
  return METRICS.find((m) => m.key === key) ?? null;
}

// ── Cross-discipline columns (columns-rejig W3, OQ1 — the all-rounder view) ────
// On a plain batting/bowling leaderboard the user can ADD a column from the OTHER
// discipline (e.g. Bowling SR on a batting table) and sort by it, so filtering
// batting SR ≥ 140 then adding Bowling SR + sorting surfaces the all-rounders.
// FILTERS stay discipline-scoped (OQ1) — only COLUMNS cross over. Fielding /
// Impact / Match-context already cross via their own per-player CTEs; this is the
// one missing case: batting metrics on a bowling table and vice versa.
//
// KEY-NAMESPACING HAZARD: batting and bowling share metric keys with DIFFERENT
// meanings ("strike_rate", "average", "dot_pct", "innings", …). A cross column
// therefore CANNOT reuse the bare key (it would collide with the current
// discipline's own column of that key, in state.columns, in the SELECT alias, and
// in getMetric resolution). It gets its own discipline-qualified identity:
//   CROSS KEY = `x__<otherDiscipline>__<baseKey>`  e.g. `x__bowling__strike_rate`
// Chosen because (a) it is identifier-safe (only letters/digits/underscore) so it
// needs NO SQL-alias quoting, (b) it self-encodes the other discipline, and (c) no
// real metric key starts with `x` or contains `__` (verified), so `startsWith(
// "x__")` is an unambiguous discriminator and splitting on the FIRST `__` after
// the prefix recovers {discipline, baseKey} exactly (base keys carry only single
// underscores). The `__sort` shadow appends as usual (`x__bowling__best__sort`),
// used only as a whole string, never re-split.
export const OTHER_DISCIPLINE = { batting: "bowling", bowling: "batting" };
const CROSS_KEY_PREFIX = "x__";

/** Build the cross-discipline column key for `baseKey` measured in `otherDiscipline`. */
export function makeCrossKey(otherDiscipline, baseKey) {
  return `${CROSS_KEY_PREFIX}${otherDiscipline}__${baseKey}`;
}

/** Parse a cross-discipline column key → { discipline, baseKey }, or null if it is
 * not a cross key (a plain key, name column, etc.). Split on the FIRST `__` after
 * the prefix: the discipline token ("batting"/"bowling") carries no underscore, so
 * everything after it is the base key verbatim. */
export function parseCrossKey(key) {
  if (typeof key !== "string" || !key.startsWith(CROSS_KEY_PREFIX)) return null;
  const rest = key.slice(CROSS_KEY_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return null;
  const discipline = rest.slice(0, sep);
  const baseKey = rest.slice(sep + 2);
  if ((discipline !== "batting" && discipline !== "bowling") || !baseKey) return null;
  return { discipline, baseKey };
}

/** True iff `key` is a cross-discipline column key. */
export function isCrossKey(key) {
  return parseCrossKey(key) !== null;
}

// Short discipline tag prefixed onto a cross column's header (shortLabel) so a
// "Bowl SR" column can never be mistaken for the batting "SR" alongside it.
const CROSS_TAG = { batting: "Bat", bowling: "Bowl" };

/** Build the VIRTUAL metric for a cross-discipline column: the OTHER discipline's
 * real metric (so sqlExpression / sortExpression / format / higherIsBetter /
 * zeroIsData all come from it, computed against ITS own view columns), re-badged
 * with the cross key as its identity + a disambiguated label. `isCrossDiscipline`
 * / `baseKey` / `xDiscipline` let buildQuery route it through the cross CTE instead
 * of the verbatim-sqlExpression path. */
function makeVirtualCrossMetric(base, crossKey, otherDiscipline) {
  return {
    ...base,
    key: crossKey,
    baseKey: base.key,
    xDiscipline: otherDiscipline,
    isCrossDiscipline: true,
    // Header disambiguation lives in shortLabel (the "Bowl"/"Bat" tag), the only
    // label the leaderboard header renders — so a "Bowl SR" column is never
    // confused with the batting "SR" beside it. `label` stays the base metric's own
    // label (no redundant prefix); columnTitle carries the fuller cross tooltip.
    shortLabel: `${CROSS_TAG[otherDiscipline]} ${base.shortLabel}`,
    columnTitle: `${base.label} — this player's ${otherDiscipline} record over the same match scope`,
  };
}

/**
 * Resolve a leaderboard COLUMN key to its metric, transparently handling both
 * plain keys and cross-discipline keys. Plain keys behave EXACTLY like
 * getMetric(key, ns) (byte-identical for every existing caller). A cross key
 * resolves to a virtual metric via the OTHER discipline's catalogue — but ONLY on
 * a plain batting/bowling table whose sibling discipline matches the key's encoded
 * discipline; on a matchup namespace, or a mismatched/unknown discipline, it
 * returns null so the stray key is safely dropped (filter(Boolean)) rather than
 * mis-rendered. */
export function resolveColumnMetric(key, ns) {
  const parsed = parseCrossKey(key);
  if (!parsed) return getMetric(key, ns);
  if (ns !== "batting" && ns !== "bowling") return null;
  if (parsed.discipline !== OTHER_DISCIPLINE[ns]) return null;
  const base = getMetric(parsed.baseKey, parsed.discipline);
  if (!base) return null;
  return makeVirtualCrossMetric(base, key, parsed.discipline);
}

// ── Composed PHASE×metric columns (columns content rework D1, 2026-08-08) ──────
// The leaderboard's Phase composer generates a column for ANY metric in the
// discipline's pool re-scoped to ANY format-eligible phase (Powerplay / Middle /
// Death, and their ODI-range variants) — REPLACING the small enumerated phase
// family (pp_strike_rate / pp_economy / pp_wickets / mid_* / death_* / odi_*).
// It mirrors the W3 cross-discipline dynamic-key scheme (makeCrossKey /
// parseCrossKey / resolveColumnMetric): a NON-static column key resolves to a
// VIRTUAL metric whose sqlExpression is generated on the fly — here, by rebuilding
// the base metric's formula from the PHASE-PREFIXED raw components the batting /
// bowling innings views carry (`<phase>_runs`, `<phase>_balls`, …; confirmed
// present flag-off via DESCRIBE for all six phase tokens).
//
// EQUIVALENCE GATE (Rule 1): for every (phase, metric) that HAD an enumerated
// column, the generated sqlExpression is BYTE-IDENTICAL to the retiring one, so
// the on-screen value is unchanged. That holds by construction — the spec
// templates below reproduce the enumerated forms exactly when {P} is substituted
// (Strike Rate ⇒ pp_strike_rate; Economy ⇒ pp_economy; Wickets ⇒ pp_wickets;
// and the mid_/death_/odi_ variants). Metrics WITHOUT an enumerated phase column
// (Average, Dots, Boundary %, …) follow the SAME formula shape as their base
// metric, with phase-prefixed component columns.
//
// KEY = `ph__<phaseToken>__<baseKey>`  e.g. `ph__pp__strike_rate`,
// `ph__odi_death__balls_per_dismissal`. Identifier-safe (needs no SQL-alias
// quoting); `__` is the field separator; phase tokens carry only single
// underscores (`odi_pp`) and no catalogued key starts with `ph__` (verified), so
// splitting on the FIRST `__` after the prefix recovers {phaseToken, baseKey}.
const COMPOSED_PHASE_PREFIX = "ph__";
// The T20 phase ranges (pp 0–5, mid 6–14, death 15–19) and the ODI ranges
// (pp 0–9, mid 10–39, death 40–49) — the exact phase-column prefixes the views use.
const COMPOSED_PHASE_TOKENS_T20 = ["pp", "mid", "death"];
const COMPOSED_PHASE_TOKENS_ODI = ["odi_pp", "odi_mid", "odi_death"];
const _PHASE_TOKEN_SET = new Set([...COMPOSED_PHASE_TOKENS_T20, ...COMPOSED_PHASE_TOKENS_ODI]);
// Row label (the composer labels each row by phase; the family header carries the
// metric) and header short tag (prefixed onto the base shortLabel in the column head).
export const COMPOSED_PHASE_LABEL = {
  pp: "Powerplay", mid: "Middle Overs", death: "Death Overs",
  odi_pp: "ODI Powerplay", odi_mid: "ODI Middle Overs", odi_death: "ODI Death Overs",
};
const COMPOSED_PHASE_SHORT = {
  pp: "PP", mid: "Mid", death: "Death",
  odi_pp: "ODI PP", odi_mid: "ODI Mid", odi_death: "ODI Death",
};

// Which phase-prefixed component SUFFIXES each view actually carries (confirmed
// flag-off via DESCRIBE batting / DESCRIBE bowling, uniform across all six phase
// tokens). A pool metric is offered ONLY when ALL its components (`needs`) are in
// this set — the task's "offer only where every component exists" guard, so if a
// component ever disappears from the pipeline the metric auto-drops rather than
// generating SQL against a missing column.
const COMPOSED_PHASE_COMPONENTS = {
  batting: new Set(["runs", "balls", "dots", "fours", "sixes", "dismissals"]),
  bowling: new Set(["balls", "runs_conceded", "wickets", "dots", "fours_conceded", "sixes_conceded"]),
};

// Per-discipline COMPONENT SPEC: for each base metric, the aggregate template (a
// `{P}` token stands for the phase prefix) + the raw component suffixes it reads.
// The template is the base metric's own formula re-expressed over `<phase>_<comp>`
// columns. `runs`/`balls`/`dots`/… here are the PHASE component names, which differ
// from the base view columns (e.g. batting SR's base uses `balls_faced` but the
// phase column is `<phase>_balls`; Average's base uses `dismissed` but the phase
// column is `<phase>_dismissals`) — hence explicit templates, not string rewriting.
const COMPOSED_PHASE_SPECS = {
  batting: {
    strike_rate: { sql: "SUM({P}_runs) * 100.0 / NULLIF(SUM({P}_balls), 0)", needs: ["runs", "balls"] },
    average: { sql: "SUM({P}_runs) * 1.0 / NULLIF(SUM({P}_dismissals), 0)", needs: ["runs", "dismissals"] },
    runs: { sql: "SUM({P}_runs)", needs: ["runs"] },
    balls_faced: { sql: "SUM({P}_balls)", needs: ["balls"] },
    dot_balls: { sql: "SUM({P}_dots)", needs: ["dots"] },
    fours: { sql: "SUM({P}_fours)", needs: ["fours"] },
    sixes: { sql: "SUM({P}_sixes)", needs: ["sixes"] },
    dismissals: { sql: "SUM({P}_dismissals)", needs: ["dismissals"] },
    dot_pct: { sql: "SUM({P}_dots) * 100.0 / NULLIF(SUM({P}_balls), 0)", needs: ["dots", "balls"] },
    boundary_pct: { sql: "(SUM({P}_fours) + SUM({P}_sixes)) * 100.0 / NULLIF(SUM({P}_balls), 0)", needs: ["fours", "sixes", "balls"] },
    balls_per_dismissal: { sql: "SUM({P}_balls) * 1.0 / NULLIF(SUM({P}_dismissals), 0)", needs: ["balls", "dismissals"] },
    boundary_balls: { sql: "SUM({P}_fours) + SUM({P}_sixes)", needs: ["fours", "sixes"] },
    boundary_runs: { sql: "4 * SUM({P}_fours) + 6 * SUM({P}_sixes)", needs: ["fours", "sixes"] },
  },
  bowling: {
    economy: { sql: "SUM({P}_runs_conceded) * 6.0 / NULLIF(SUM({P}_balls), 0)", needs: ["runs_conceded", "balls"] },
    wickets: { sql: "SUM({P}_wickets)", needs: ["wickets"] },
    runs_conceded: { sql: "SUM({P}_runs_conceded)", needs: ["runs_conceded"] },
    balls: { sql: "SUM({P}_balls)", needs: ["balls"] },
    dot_balls_conceded: { sql: "SUM({P}_dots)", needs: ["dots"] },
    average: { sql: "SUM({P}_runs_conceded) * 1.0 / NULLIF(SUM({P}_wickets), 0)", needs: ["runs_conceded", "wickets"] },
    strike_rate: { sql: "SUM({P}_balls) * 1.0 / NULLIF(SUM({P}_wickets), 0)", needs: ["balls", "wickets"] },
    dot_pct: { sql: "SUM({P}_dots) * 100.0 / NULLIF(SUM({P}_balls), 0)", needs: ["dots", "balls"] },
    fours_conceded: { sql: "SUM({P}_fours_conceded)", needs: ["fours_conceded"] },
    sixes_conceded: { sql: "SUM({P}_sixes_conceded)", needs: ["sixes_conceded"] },
    boundary_pct_conceded: { sql: "(SUM({P}_fours_conceded) + SUM({P}_sixes_conceded)) * 100.0 / NULLIF(SUM({P}_balls), 0)", needs: ["fours_conceded", "sixes_conceded", "balls"] },
    boundary_runs_pct: { sql: "(4 * SUM({P}_fours_conceded) + 6 * SUM({P}_sixes_conceded)) * 100.0 / NULLIF(SUM({P}_runs_conceded), 0)", needs: ["fours_conceded", "sixes_conceded", "runs_conceded"] },
  },
};

// Display order of the metric pool inside each discipline's Phase composer (v5
// audit order: rates/counts then percents/detailed). Only keys with a spec AND all
// components present are offered — see composedPhasePool().
const COMPOSED_PHASE_POOL_ORDER = {
  batting: [
    "strike_rate", "average", "runs", "balls_faced", "dot_balls", "fours", "sixes",
    "dismissals", "dot_pct", "boundary_pct", "balls_per_dismissal", "boundary_balls", "boundary_runs",
  ],
  bowling: [
    "economy", "wickets", "runs_conceded", "balls", "dot_balls_conceded", "average",
    "strike_rate", "dot_pct", "fours_conceded", "sixes_conceded", "boundary_pct_conceded", "boundary_runs_pct",
  ],
};

/** Build the composed-phase column key for `baseKey` re-scoped to `phaseToken`. */
export function makeComposedPhaseKey(phaseToken, baseKey) {
  return `${COMPOSED_PHASE_PREFIX}${phaseToken}__${baseKey}`;
}

/** Parse a composed-phase column key → { phaseToken, baseKey }, or null if it is
 * not one. Split on the FIRST `__` after the `ph__` prefix (phase tokens carry no
 * `__`; base keys carry only single underscores). */
export function parseComposedPhaseKey(key) {
  if (typeof key !== "string" || !key.startsWith(COMPOSED_PHASE_PREFIX)) return null;
  const rest = key.slice(COMPOSED_PHASE_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return null;
  const phaseToken = rest.slice(0, sep);
  const baseKey = rest.slice(sep + 2);
  if (!_PHASE_TOKEN_SET.has(phaseToken) || !baseKey) return null;
  return { phaseToken, baseKey };
}

/** True iff `key` is a composed-phase column key. */
export function isComposedPhaseKey(key) {
  return parseComposedPhaseKey(key) !== null;
}

/** True iff every component the `baseKey` spec needs exists in `discipline`'s view. */
function composedComponentsPresent(discipline, spec) {
  const have = COMPOSED_PHASE_COMPONENTS[discipline];
  return !!have && spec.needs.every((c) => have.has(c));
}

/** Build the VIRTUAL metric for a composed-phase column: the base metric's own
 * format / higherIsBetter / zeroIsData / kind / additive / source ("innings"),
 * re-badged with the composed key + a phase-prefixed label, and with a freshly
 * GENERATED sqlExpression (base formula over `<phase>_<component>` columns). Its
 * source stays "innings", so buildQuery's inningsMetrics loop projects it exactly
 * like any real innings metric — no query-builder change. Returns null when the
 * base metric / spec is unknown or a component is missing. */
function buildComposedPhaseMetric(phaseToken, baseKey, discipline) {
  if (discipline !== "batting" && discipline !== "bowling") return null;
  if (!_PHASE_TOKEN_SET.has(phaseToken)) return null;
  const specMap = COMPOSED_PHASE_SPECS[discipline];
  const spec = specMap && specMap[baseKey];
  if (!spec || !composedComponentsPresent(discipline, spec)) return null;
  const base = getMetric(baseKey, discipline);
  if (!base) return null;
  return {
    ...base,
    key: makeComposedPhaseKey(phaseToken, baseKey),
    baseKey,
    phaseToken,
    isComposedPhase: true,
    sqlExpression: spec.sql.split("{P}").join(phaseToken),
    label: `${COMPOSED_PHASE_LABEL[phaseToken]} ${base.label}`,
    shortLabel: `${COMPOSED_PHASE_SHORT[phaseToken]} ${base.shortLabel}`,
    // Phase-gated exactly like the enumerated phase metrics (§8.9): T20 ranges show
    // only when the single selected format is T20, ODI ranges only for 50 Over.
    isPhaseMetric: phaseToken.startsWith("odi_") ? "odi" : "t20",
  };
}

/** Resolve a composed-phase COLUMN key to its virtual metric, or null when it is
 * not a composed key / the discipline can't compose it. Called by getMetric (so
 * resolveColumnMetric picks it up for free too — a composed key is not a cross
 * key, so resolveColumnMetric falls through to getMetric). */
export function resolveComposedPhaseMetric(key, discipline) {
  const parsed = parseComposedPhaseKey(key);
  if (!parsed) return null;
  return buildComposedPhaseMetric(parsed.phaseToken, parsed.baseKey, discipline);
}

/** The active phase tokens for the current format selection, matching
 * phaseMetricAllowed's §8.9 gate exactly: T20 ranges only when the SINGLE selected
 * format is T20; ODI ranges only when it is 50 Over; [] for any mixed / red-ball /
 * empty selection (so the composer hides, like the enumerated phase family). */
export function composedPhaseTokensForFormats(formats) {
  const f = formats || [];
  if (f.length === 1 && f[0] === "T20") return COMPOSED_PHASE_TOKENS_T20;
  if (f.length === 1 && f[0] === "50 Over") return COMPOSED_PHASE_TOKENS_ODI;
  return [];
}

/** The ordered base metrics the `discipline` Phase composer offers (each resolved
 * from the catalogue), filtered to those with a spec AND all components present. */
export function composedPhasePool(discipline) {
  const order = COMPOSED_PHASE_POOL_ORDER[discipline];
  const specMap = COMPOSED_PHASE_SPECS[discipline];
  if (!order || !specMap) return [];
  const pool = [];
  for (const baseKey of order) {
    const spec = specMap[baseKey];
    if (!spec || !composedComponentsPresent(discipline, spec)) continue;
    const base = getMetric(baseKey, discipline);
    if (base) pool.push(base);
  }
  return pool;
}

/** Every VALID composed-phase column key for the current discipline + formats —
 * the pool × the format-eligible phase tokens. Folded into eligibleColumnKeys
 * (state.js) so a composed column survives a re-render but is pruned the moment the
 * format no longer permits its phase (exactly like the enumerated phase columns). */
export function eligibleComposedPhaseKeys(discipline, formats) {
  const phaseTokens = composedPhaseTokensForFormats(formats);
  if (!phaseTokens.length) return [];
  const keys = [];
  for (const base of composedPhasePool(discipline)) {
    for (const ph of phaseTokens) keys.push(makeComposedPhaseKey(ph, base.key));
  }
  return keys;
}

// ── Composed BALL-RANGE×metric columns (columns content rework D2, 2026-08-08) ─
// The leaderboard's Ball Range composer generates a column for any pool metric
// re-scoped to a FACED-BALL bucket of the innings (the batter's first 10 balls,
// balls 11–20, then 21+) — REPLACING the enumerated `sr_first10` / `sr_11_20` /
// `sr_21plus` columns in the leaderboard picker (their defs stay in the catalogue
// for the pop-up / filters / graph / the Progression preset, which D2 repoints).
// It mirrors the D1 phase scheme EXACTLY: a non-static key resolves to a VIRTUAL
// metric whose sqlExpression is rebuilt from the bucket-prefixed raw components
// the batting view carries (`<bucket>_runs`, `<bucket>_balls`). These are
// FACED-BALL buckets, NOT over-phases, so they are FORMAT-AGNOSTIC and NOT
// phase-gated (exactly like the enumerated sr_* they replace).
//
// EQUIVALENCE GATE (Rule 1): composed First-10-balls × (Batting) Strike Rate is
// BYTE-IDENTICAL to the retiring `sr_first10` sqlExpression, and likewise
// 11–20 ⇒ sr_11_20, 21+ ⇒ sr_21plus — the spec template reproduces those exact
// forms when {B} is substituted. Runs / Balls Faced re-scoped to a bucket have no
// enumerated equivalent (they are new), following the same SUM(<bucket>_…) shape.
//
// DATA (confirmed flag-off via DESCRIBE batting / DESCRIBE bowling on R2): each
// batting bucket carries ONLY runs + balls (no per-bucket fours/dots/dismissals),
// so the pool is {Strike Rate, Runs, Balls Faced}. The BOWLING view carries NO
// fb* bucket columns at all, so composedBallPool("bowling") is empty and the
// bowling Ball Range composer is never offered (data-driven — a bowling ball-range
// would need a pipeline/parquet build, like byes/leg-byes; flagged for later).
//
// KEY = `bl__<bucketToken>__<baseKey>`  e.g. `bl__fb1_10__strike_rate`. The bucket
// tokens are the exact view-column prefixes (`fb1_10`, `fb11_20`, `fb21p`), which
// carry only single underscores, so splitting on the FIRST `__` after the `bl__`
// prefix recovers {bucketToken, baseKey}. No catalogued key starts with `bl__`.
const COMPOSED_BALL_PREFIX = "bl__";
const COMPOSED_BALL_TOKENS = ["fb1_10", "fb11_20", "fb21p"];
const _BALL_TOKEN_SET = new Set(COMPOSED_BALL_TOKENS);
// Composer row label (the family sub-header carries the metric) + header short tag.
export const COMPOSED_BALL_LABEL = {
  fb1_10: "First 10 Balls", fb11_20: "Balls 11–20", fb21p: "21+ Balls",
};
const COMPOSED_BALL_SHORT = { fb1_10: "1-10", fb11_20: "11-20", fb21p: "21+" };
// Bucket component SUFFIXES each view carries (batting only). A pool metric is
// offered ONLY when ALL its `needs` are present, so a component vanishing from the
// pipeline auto-drops the metric instead of generating SQL against a missing column.
const COMPOSED_BALL_COMPONENTS = {
  batting: new Set(["runs", "balls"]),
  // bowling: (no fb* bucket columns in the view) — pool stays empty.
};
// Per-discipline COMPONENT SPEC: the base metric's formula re-expressed over
// `<bucket>_<comp>` columns ({B} = bucket prefix). Only metrics whose components
// live in the bucket set can be composed.
const COMPOSED_BALL_SPECS = {
  batting: {
    strike_rate: { sql: "SUM({B}_runs) * 100.0 / NULLIF(SUM({B}_balls), 0)", needs: ["runs", "balls"] },
    runs: { sql: "SUM({B}_runs)", needs: ["runs"] },
    balls_faced: { sql: "SUM({B}_balls)", needs: ["balls"] },
  },
};
// Composer display order of the metric pool.
const COMPOSED_BALL_POOL_ORDER = {
  batting: ["strike_rate", "runs", "balls_faced"],
};

/** Build the composed-ball column key for `baseKey` re-scoped to `bucketToken`. */
export function makeComposedBallKey(bucketToken, baseKey) {
  return `${COMPOSED_BALL_PREFIX}${bucketToken}__${baseKey}`;
}

/** Parse a composed-ball column key → { bucketToken, baseKey }, or null. Split on
 * the FIRST `__` after the `bl__` prefix (bucket tokens carry no `__`). */
export function parseComposedBallKey(key) {
  if (typeof key !== "string" || !key.startsWith(COMPOSED_BALL_PREFIX)) return null;
  const rest = key.slice(COMPOSED_BALL_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return null;
  const bucketToken = rest.slice(0, sep);
  const baseKey = rest.slice(sep + 2);
  if (!_BALL_TOKEN_SET.has(bucketToken) || !baseKey) return null;
  return { bucketToken, baseKey };
}

/** True iff every component the `baseKey` spec needs exists in `discipline`'s bucket set. */
function composedBallComponentsPresent(discipline, spec) {
  const have = COMPOSED_BALL_COMPONENTS[discipline];
  return !!have && spec.needs.every((c) => have.has(c));
}

/** Build the VIRTUAL metric for a composed-ball column: the base metric's own
 * format / higherIsBetter / zeroIsData / kind / source ("innings"), re-badged with
 * the composed key + a bucket-prefixed label, and a GENERATED sqlExpression (base
 * formula over `<bucket>_<component>` columns). isPhaseMetric stays the base's null
 * (faced-ball buckets are format-agnostic). Returns null when the base/spec is
 * unknown or a component is missing. */
function buildComposedBallMetric(bucketToken, baseKey, discipline) {
  if (discipline !== "batting" && discipline !== "bowling") return null;
  if (!_BALL_TOKEN_SET.has(bucketToken)) return null;
  const specMap = COMPOSED_BALL_SPECS[discipline];
  const spec = specMap && specMap[baseKey];
  if (!spec || !composedBallComponentsPresent(discipline, spec)) return null;
  const base = getMetric(baseKey, discipline);
  if (!base) return null;
  return {
    ...base,
    key: makeComposedBallKey(bucketToken, baseKey),
    baseKey,
    ballToken: bucketToken,
    isComposedBall: true,
    sqlExpression: spec.sql.split("{B}").join(bucketToken),
    label: `${COMPOSED_BALL_LABEL[bucketToken]} ${base.label}`,
    shortLabel: `${COMPOSED_BALL_SHORT[bucketToken]} ${base.shortLabel}`,
  };
}

/** Resolve a composed-ball COLUMN key to its virtual metric, or null when it is
 * not a composed-ball key / the discipline can't compose it. Called by getMetric. */
export function resolveComposedBallMetric(key, discipline) {
  const parsed = parseComposedBallKey(key);
  if (!parsed) return null;
  return buildComposedBallMetric(parsed.bucketToken, parsed.baseKey, discipline);
}

/** The ordered base metrics the `discipline` Ball Range composer offers, filtered
 * to those with a spec AND all components present (empty for bowling → not offered). */
export function composedBallPool(discipline) {
  const order = COMPOSED_BALL_POOL_ORDER[discipline];
  const specMap = COMPOSED_BALL_SPECS[discipline];
  if (!order || !specMap) return [];
  const pool = [];
  for (const baseKey of order) {
    const spec = specMap[baseKey];
    if (!spec || !composedBallComponentsPresent(discipline, spec)) continue;
    const base = getMetric(baseKey, discipline);
    if (base) pool.push(base);
  }
  return pool;
}

/** The ball-range bucket tokens (format-agnostic — faced-ball buckets exist for
 * every format), for the composer to iterate. */
export function composedBallTokens() {
  return COMPOSED_BALL_TOKENS;
}

/** Every VALID composed-ball column key for the current discipline (bucket tokens
 * are format-agnostic, so `formats` is unused — the signature mirrors the phase/
 * innings helpers). Folded into eligibleColumnKeys so a composed ball column
 * survives a re-render. */
export function eligibleComposedBallKeys(discipline, _formats) {
  const keys = [];
  for (const base of composedBallPool(discipline)) {
    for (const tok of COMPOSED_BALL_TOKENS) keys.push(makeComposedBallKey(tok, base.key));
  }
  return keys;
}

// ── Composed INNINGS-RANGE×metric columns (columns content rework D2) ──────────
// The leaderboard's Innings Range composer generates a column for any pool metric
// computed over ONLY a single innings number (1st / 2nd, plus 3rd / 4th for
// red-ball) — via CONDITIONAL AGGREGATION, a DIFFERENT shape from the phase / ball
// composers (those read precomputed bucket columns; this gates the BASE columns
// with a CASE on `innings_number`). e.g. Innings-1 Runs = SUM(CASE WHEN
// innings_number = 0 THEN runs ELSE 0 END). There is NO enumerated equivalent —
// this dimension is new.
//
// CRITICAL (Rule 1): `innings_number` in the batting/bowling views is 0-BASED
// (INNINGS_NUMBER_FILTER.zeroBased) — display "1st innings" is STORED 0. So the
// stored predicate for display innings N is `innings_number = N-1`. (The task
// brief's illustrative SQL used `= 1` for the 1st innings; that would be WRONG
// here — verified against filters.js's Innings Number predicate + db_reference.)
//
// INNINGS-NUMBER FILTER INTERACTION: a composed Innings-k column's CASE and the
// Innings Number FILTER's WHERE compose correctly — the WHERE narrows WHICH rows
// are scanned, the CASE picks innings-k WITHIN them. If both name the same innings
// the CASE is a no-op over the already-narrowed rows (identical value); if they
// name different innings the CASE matches nothing → 0/— (correct: there are no
// innings-k rows inside an innings-j-only scope). With NO composed innings column
// present the query is byte-identical (no CASE, no innings_number reference added).
//
// KEY = `in__<iToken>__<baseKey>`  e.g. `in__i1__strike_rate`. Tokens i1..i4 are
// the DISPLAY innings numbers; stored = tokenNumber-1. Tokens carry no `__`; no
// catalogued key starts with `in__` (the plain "innings" key is "innings", never
// "in__…"). Which tokens are eligible tracks the Innings Number filter exactly
// (inningsNumberOptions): i1/i2 always, i3/i4 only when Red Ball is in scope.
const COMPOSED_INNINGS_PREFIX = "in__";
const COMPOSED_INNINGS_TOKENS = ["i1", "i2", "i3", "i4"];
const _INNINGS_TOKEN_SET = new Set(COMPOSED_INNINGS_TOKENS);
export const COMPOSED_INNINGS_LABEL = {
  i1: "1st Innings", i2: "2nd Innings", i3: "3rd Innings", i4: "4th Innings",
};
const COMPOSED_INNINGS_SHORT = {
  i1: "1st Inns", i2: "2nd Inns", i3: "3rd Inns", i4: "4th Inns",
};
/** Stored 0-based innings_number for a display token ("i1" → 0, "i4" → 3). */
function inningsTokenToStored(token) {
  return Number(token.slice(1)) - 1;
}
// The BASE view columns each conditional metric reads. A pool metric is offered
// only when ALL its `needs` exist (confirmed flag-off via DESCRIBE for both views).
const COMPOSED_INNINGS_COMPONENTS = {
  batting: new Set(["runs", "balls_faced", "dots", "fours_hit", "sixes_hit", "dismissed"]),
  bowling: new Set(["balls", "runs_conceded", "wickets", "dots", "fours_conceded", "sixes_conceded"]),
};
// Per-discipline COMPONENT SPEC: the base metric's formula with every SUM(col)
// re-expressed as SUM(CASE WHEN innings_number = {S} THEN col ELSE 0 END) ({S} =
// stored 0-based innings number). Denominators keep the same NULLIF(…, 0) guard,
// so an innings the player never played yields 0 → NULL → "—" for rates (§8.1),
// matching every base rate metric.
const COMPOSED_INNINGS_SPECS = {
  batting: {
    strike_rate: { sql: "SUM(CASE WHEN innings_number = {S} THEN runs ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN innings_number = {S} THEN balls_faced ELSE 0 END), 0)", needs: ["runs", "balls_faced"] },
    average: { sql: "SUM(CASE WHEN innings_number = {S} THEN runs ELSE 0 END) * 1.0 / NULLIF(SUM(CASE WHEN innings_number = {S} THEN dismissed ELSE 0 END), 0)", needs: ["runs", "dismissed"] },
    runs: { sql: "SUM(CASE WHEN innings_number = {S} THEN runs ELSE 0 END)", needs: ["runs"] },
    balls_faced: { sql: "SUM(CASE WHEN innings_number = {S} THEN balls_faced ELSE 0 END)", needs: ["balls_faced"] },
    dot_balls: { sql: "SUM(CASE WHEN innings_number = {S} THEN dots ELSE 0 END)", needs: ["dots"] },
    fours: { sql: "SUM(CASE WHEN innings_number = {S} THEN fours_hit ELSE 0 END)", needs: ["fours_hit"] },
    sixes: { sql: "SUM(CASE WHEN innings_number = {S} THEN sixes_hit ELSE 0 END)", needs: ["sixes_hit"] },
    dismissals: { sql: "SUM(CASE WHEN innings_number = {S} THEN dismissed ELSE 0 END)", needs: ["dismissed"] },
    dot_pct: { sql: "SUM(CASE WHEN innings_number = {S} THEN dots ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN innings_number = {S} THEN balls_faced ELSE 0 END), 0)", needs: ["dots", "balls_faced"] },
    boundary_pct: { sql: "(SUM(CASE WHEN innings_number = {S} THEN fours_hit ELSE 0 END) + SUM(CASE WHEN innings_number = {S} THEN sixes_hit ELSE 0 END)) * 100.0 / NULLIF(SUM(CASE WHEN innings_number = {S} THEN balls_faced ELSE 0 END), 0)", needs: ["fours_hit", "sixes_hit", "balls_faced"] },
    balls_per_dismissal: { sql: "SUM(CASE WHEN innings_number = {S} THEN balls_faced ELSE 0 END) * 1.0 / NULLIF(SUM(CASE WHEN innings_number = {S} THEN dismissed ELSE 0 END), 0)", needs: ["balls_faced", "dismissed"] },
    boundary_balls: { sql: "SUM(CASE WHEN innings_number = {S} THEN fours_hit ELSE 0 END) + SUM(CASE WHEN innings_number = {S} THEN sixes_hit ELSE 0 END)", needs: ["fours_hit", "sixes_hit"] },
    boundary_runs: { sql: "4 * SUM(CASE WHEN innings_number = {S} THEN fours_hit ELSE 0 END) + 6 * SUM(CASE WHEN innings_number = {S} THEN sixes_hit ELSE 0 END)", needs: ["fours_hit", "sixes_hit"] },
  },
  bowling: {
    economy: { sql: "SUM(CASE WHEN innings_number = {S} THEN runs_conceded ELSE 0 END) * 6.0 / NULLIF(SUM(CASE WHEN innings_number = {S} THEN balls ELSE 0 END), 0)", needs: ["runs_conceded", "balls"] },
    wickets: { sql: "SUM(CASE WHEN innings_number = {S} THEN wickets ELSE 0 END)", needs: ["wickets"] },
    runs_conceded: { sql: "SUM(CASE WHEN innings_number = {S} THEN runs_conceded ELSE 0 END)", needs: ["runs_conceded"] },
    balls: { sql: "SUM(CASE WHEN innings_number = {S} THEN balls ELSE 0 END)", needs: ["balls"] },
    dot_balls_conceded: { sql: "SUM(CASE WHEN innings_number = {S} THEN dots ELSE 0 END)", needs: ["dots"] },
    average: { sql: "SUM(CASE WHEN innings_number = {S} THEN runs_conceded ELSE 0 END) * 1.0 / NULLIF(SUM(CASE WHEN innings_number = {S} THEN wickets ELSE 0 END), 0)", needs: ["runs_conceded", "wickets"] },
    strike_rate: { sql: "SUM(CASE WHEN innings_number = {S} THEN balls ELSE 0 END) * 1.0 / NULLIF(SUM(CASE WHEN innings_number = {S} THEN wickets ELSE 0 END), 0)", needs: ["balls", "wickets"] },
    dot_pct: { sql: "SUM(CASE WHEN innings_number = {S} THEN dots ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN innings_number = {S} THEN balls ELSE 0 END), 0)", needs: ["dots", "balls"] },
    fours_conceded: { sql: "SUM(CASE WHEN innings_number = {S} THEN fours_conceded ELSE 0 END)", needs: ["fours_conceded"] },
    sixes_conceded: { sql: "SUM(CASE WHEN innings_number = {S} THEN sixes_conceded ELSE 0 END)", needs: ["sixes_conceded"] },
    boundary_pct_conceded: { sql: "(SUM(CASE WHEN innings_number = {S} THEN fours_conceded ELSE 0 END) + SUM(CASE WHEN innings_number = {S} THEN sixes_conceded ELSE 0 END)) * 100.0 / NULLIF(SUM(CASE WHEN innings_number = {S} THEN balls ELSE 0 END), 0)", needs: ["fours_conceded", "sixes_conceded", "balls"] },
    boundary_runs_pct: { sql: "(4 * SUM(CASE WHEN innings_number = {S} THEN fours_conceded ELSE 0 END) + 6 * SUM(CASE WHEN innings_number = {S} THEN sixes_conceded ELSE 0 END)) * 100.0 / NULLIF(SUM(CASE WHEN innings_number = {S} THEN runs_conceded ELSE 0 END), 0)", needs: ["fours_conceded", "sixes_conceded", "runs_conceded"] },
  },
};
const COMPOSED_INNINGS_POOL_ORDER = {
  batting: [
    "strike_rate", "average", "runs", "balls_faced", "dot_balls", "fours", "sixes",
    "dismissals", "dot_pct", "boundary_pct", "balls_per_dismissal", "boundary_balls", "boundary_runs",
  ],
  bowling: [
    "economy", "wickets", "runs_conceded", "balls", "dot_balls_conceded", "average",
    "strike_rate", "dot_pct", "fours_conceded", "sixes_conceded", "boundary_pct_conceded", "boundary_runs_pct",
  ],
};

/** Build the composed-innings column key for `baseKey` scoped to `inningsToken`. */
export function makeComposedInningsKey(inningsToken, baseKey) {
  return `${COMPOSED_INNINGS_PREFIX}${inningsToken}__${baseKey}`;
}

/** Parse a composed-innings column key → { inningsToken, baseKey }, or null. */
export function parseComposedInningsKey(key) {
  if (typeof key !== "string" || !key.startsWith(COMPOSED_INNINGS_PREFIX)) return null;
  const rest = key.slice(COMPOSED_INNINGS_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return null;
  const inningsToken = rest.slice(0, sep);
  const baseKey = rest.slice(sep + 2);
  if (!_INNINGS_TOKEN_SET.has(inningsToken) || !baseKey) return null;
  return { inningsToken, baseKey };
}

/** True iff every component the `baseKey` spec needs exists in `discipline`'s view. */
function composedInningsComponentsPresent(discipline, spec) {
  const have = COMPOSED_INNINGS_COMPONENTS[discipline];
  return !!have && spec.needs.every((c) => have.has(c));
}

/** Build the VIRTUAL metric for a composed-innings column: the base metric's own
 * format / higherIsBetter / zeroIsData / kind / source ("innings"), re-badged with
 * the composed key + an innings-prefixed label, and a GENERATED conditional-
 * aggregation sqlExpression (stored 0-based innings_number substituted for {S}).
 * isPhaseMetric stays the base's null — innings 1/2 exist for every format; token
 * eligibility (i3/i4 red-ball only) is enforced by eligibleComposedInningsKeys, not
 * phase gating. Returns null when the base/spec is unknown or a component missing. */
function buildComposedInningsMetric(inningsToken, baseKey, discipline) {
  if (discipline !== "batting" && discipline !== "bowling") return null;
  if (!_INNINGS_TOKEN_SET.has(inningsToken)) return null;
  const specMap = COMPOSED_INNINGS_SPECS[discipline];
  const spec = specMap && specMap[baseKey];
  if (!spec || !composedInningsComponentsPresent(discipline, spec)) return null;
  const base = getMetric(baseKey, discipline);
  if (!base) return null;
  const stored = inningsTokenToStored(inningsToken);
  return {
    ...base,
    key: makeComposedInningsKey(inningsToken, baseKey),
    baseKey,
    inningsToken,
    isComposedInnings: true,
    sqlExpression: spec.sql.split("{S}").join(String(stored)),
    label: `${COMPOSED_INNINGS_LABEL[inningsToken]} ${base.label}`,
    shortLabel: `${COMPOSED_INNINGS_SHORT[inningsToken]} ${base.shortLabel}`,
  };
}

/** Resolve a composed-innings COLUMN key to its virtual metric, or null. Called by getMetric. */
export function resolveComposedInningsMetric(key, discipline) {
  const parsed = parseComposedInningsKey(key);
  if (!parsed) return null;
  return buildComposedInningsMetric(parsed.inningsToken, parsed.baseKey, discipline);
}

/** The innings tokens selectable under `formats`, mirroring the Innings Number
 * filter's own option set (inningsNumberOptions): i1/i2 always, i3/i4 only when
 * Red Ball is in the format selection (a Test/MDM can have four innings). */
export function composedInningsTokensForFormats(formats) {
  return (formats || []).includes("Red Ball")
    ? COMPOSED_INNINGS_TOKENS
    : COMPOSED_INNINGS_TOKENS.slice(0, 2);
}

/** The ordered base metrics the `discipline` Innings Range composer offers,
 * filtered to those with a spec AND all components present. */
export function composedInningsPool(discipline) {
  const order = COMPOSED_INNINGS_POOL_ORDER[discipline];
  const specMap = COMPOSED_INNINGS_SPECS[discipline];
  if (!order || !specMap) return [];
  const pool = [];
  for (const baseKey of order) {
    const spec = specMap[baseKey];
    if (!spec || !composedInningsComponentsPresent(discipline, spec)) continue;
    const base = getMetric(baseKey, discipline);
    if (base) pool.push(base);
  }
  return pool;
}

/** Every VALID composed-innings column key for the current discipline + formats —
 * the pool × the format-eligible innings tokens. Folded into eligibleColumnKeys so
 * a composed innings column survives a re-render but is pruned the moment the
 * format no longer permits its innings (i3/i4 drop when Red Ball leaves scope). */
export function eligibleComposedInningsKeys(discipline, formats) {
  const tokens = composedInningsTokensForFormats(formats);
  if (!tokens.length) return [];
  const keys = [];
  for (const base of composedInningsPool(discipline)) {
    for (const tok of tokens) keys.push(makeComposedInningsKey(tok, base.key));
  }
  return keys;
}

// ── Composed RUN-SOURCE × count/% columns (columns content rework D3, 2026-08-08)
// The leaderboard's "Runs by Source" composer generates, per run source (1s / 2s /
// 3s / 4s-run / 4s-boundary / 5s / 6s-run / 6s-boundary), a column that is EITHER
// the run total from that source (count axis) OR that total as a share of the
// batter's runs (% axis) — the axis chosen by the SAME per-column count/% toggle
// Wave C built. REPLACES the enumerated runs_1s_pct … runs_6s_boundary_pct % columns
// in the leaderboard OWN-discipline picker (their defs stay in the catalogue for the
// pop-up / filters / graph / per-innings slicing). "All Boundaries" is the
// composer's ninth row but REUSES the catalogued boundary_runs / boundary_runs_pct
// pair (its count already exists from Wave B), so no composed key is minted for it
// (see columnsPicker's runSourceComposerHTML) — that also keeps it a single source
// of truth with the Detailed-section Boundary Runs column.
//
// EQUIVALENCE GATE (Rule 1): each source's % sqlExpression is BYTE-IDENTICAL to the
// retiring enumerated runs_<source>_pct — the % template `(<num>) * 100.0 /
// NULLIF(SUM(runs), 0)` reproduces the enumerated form exactly (e.g. 6s-boundary ⇒
// `(6 * SUM(sixes_hit)) * 100.0 / NULLIF(SUM(runs), 0)` == runs_6s_boundary_pct).
// The count side is the same run-total numerator without the /runs share — a new
// counting total. Batting-only (run composition is a batting concept).
//
// KEY = `rs__<sourceToken>__<axis>`  axis ∈ {runs (count), pct}. Source tokens carry
// only single underscores (4s_run, 6s_bdry); no catalogued key starts with `rs__`;
// axis carries no underscore — so splitting on the FIRST `__` after the prefix
// recovers {token, axis}.
const COMPOSED_RUNSOURCE_PREFIX = "rs__";
const COMPOSED_RUNSOURCE_AXES = new Set(["runs", "pct"]);
// token, composer ROW label, run-total numerator, and the count/% column
// labels+shorts (the % ones REPRODUCE the enumerated runs_<source>_pct display).
const COMPOSED_RUNSOURCE_DIMS = [
  { token: "1s",      rowLabel: "1s",            num: "1 * SUM(ones)",      countLabel: "Runs in 1s",            countShort: "1s Runs",      pctLabel: "% Runs in 1s",            pctShort: "1s Run%" },
  { token: "2s",      rowLabel: "2s",            num: "2 * SUM(twos)",      countLabel: "Runs in 2s",            countShort: "2s Runs",      pctLabel: "% Runs in 2s",            pctShort: "2s Run%" },
  { token: "3s",      rowLabel: "3s",            num: "3 * SUM(threes)",    countLabel: "Runs in 3s",            countShort: "3s Runs",      pctLabel: "% Runs in 3s",            pctShort: "3s Run%" },
  { token: "4s_run",  rowLabel: "4s (run)",      num: "4 * SUM(nb_fours)",  countLabel: "Runs in 4s (run)",      countShort: "4s-run Runs",  pctLabel: "% Runs in 4s (run)",      pctShort: "4s-run%" },
  { token: "4s_bdry", rowLabel: "4s (boundary)", num: "4 * SUM(fours_hit)", countLabel: "Runs in 4s (boundary)", countShort: "4s-bdry Runs", pctLabel: "% Runs in 4s (boundary)", pctShort: "4s-bdry%" },
  { token: "5s",      rowLabel: "5s",            num: "5 * SUM(fives)",     countLabel: "Runs in 5s",            countShort: "5s Runs",      pctLabel: "% Runs in 5s",            pctShort: "5s Run%" },
  { token: "6s_run",  rowLabel: "6s (run)",      num: "6 * SUM(nb_sixes)",  countLabel: "Runs in 6s (run)",      countShort: "6s-run Runs",  pctLabel: "% Runs in 6s (run)",      pctShort: "6s-run%" },
  { token: "6s_bdry", rowLabel: "6s (boundary)", num: "6 * SUM(sixes_hit)", countLabel: "Runs in 6s (boundary)", countShort: "6s-bdry Runs", pctLabel: "% Runs in 6s (boundary)", pctShort: "6s-bdry%" },
];
const _RUNSOURCE_BY_TOKEN = new Map(COMPOSED_RUNSOURCE_DIMS.map((d) => [d.token, d]));
const _RUNSOURCE_TOKEN_SET = new Set(COMPOSED_RUNSOURCE_DIMS.map((d) => d.token));

/** Build the composed run-source column key for `sourceToken` on `axis`. */
export function makeComposedRunSourceKey(sourceToken, axis) {
  return `${COMPOSED_RUNSOURCE_PREFIX}${sourceToken}__${axis}`;
}
/** Parse a composed run-source column key → { token, axis }, or null. Split on the
 * FIRST `__` after the `rs__` prefix (source tokens carry no `__`; axis is a bare word). */
export function parseComposedRunSourceKey(key) {
  if (typeof key !== "string" || !key.startsWith(COMPOSED_RUNSOURCE_PREFIX)) return null;
  const rest = key.slice(COMPOSED_RUNSOURCE_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return null;
  const token = rest.slice(0, sep);
  const axis = rest.slice(sep + 2);
  if (!_RUNSOURCE_TOKEN_SET.has(token) || !COMPOSED_RUNSOURCE_AXES.has(axis)) return null;
  return { token, axis };
}
/** Build the VIRTUAL metric for a composed run-source column (batting only). Count
 * axis = the run-total numerator (kind "total"); pct axis = that numerator over
 * SUM(runs) — byte-identical to the enumerated runs_<source>_pct. source stays
 * "innings" so buildQuery's inningsMetrics loop projects it like any real metric. */
function buildComposedRunSourceMetric(token, axis, discipline) {
  if (discipline !== "batting") return null;
  const dim = _RUNSOURCE_BY_TOKEN.get(token);
  if (!dim || !COMPOSED_RUNSOURCE_AXES.has(axis)) return null;
  const key = makeComposedRunSourceKey(token, axis);
  if (axis === "runs") {
    return {
      key, baseToken: token, isComposedRunSource: true,
      label: dim.countLabel, shortLabel: dim.countShort,
      discipline: "batting", source: "innings",
      sqlExpression: dim.num,
      higherIsBetter: null, format: "int",
      isPhaseMetric: null, zeroIsData: true, additive: true, kind: "total",
    };
  }
  return {
    key, baseToken: token, isComposedRunSource: true,
    label: dim.pctLabel, shortLabel: dim.pctShort,
    discipline: "batting", source: "innings",
    sqlExpression: `(${dim.num}) * 100.0 / NULLIF(SUM(runs), 0)`,
    higherIsBetter: null, format: "pct1",
    isPhaseMetric: null, zeroIsData: false, kind: "percent",
  };
}
/** Resolve a composed run-source COLUMN key to its virtual metric, or null. Called
 * by getMetric (so resolveColumnMetric picks it up too). */
export function resolveComposedRunSourceMetric(key, discipline) {
  const parsed = parseComposedRunSourceKey(key);
  if (!parsed) return null;
  return buildComposedRunSourceMetric(parsed.token, parsed.axis, discipline);
}
/** Ordered composer rows for the batting Runs by Source composer: the 8 composed
 * sources + a final "Boundaries" row that REUSES the catalogued boundary_runs /
 * boundary_runs_pct pair (no composed key). Each row = { rowLabel, countKey, pctKey }
 * → a Wave-C count/% toggle row in columnsPicker. */
export function composedRunSourceRows() {
  const rows = COMPOSED_RUNSOURCE_DIMS.map((d) => ({
    rowLabel: d.rowLabel,
    countKey: makeComposedRunSourceKey(d.token, "runs"),
    pctKey: makeComposedRunSourceKey(d.token, "pct"),
  }));
  rows.push({ rowLabel: "Boundaries", countKey: "boundary_runs", pctKey: "boundary_runs_pct" });
  return rows;
}
/** Every composed run-source column key (batting only) — folded into
 * eligibleColumnKeys so they survive a re-render. Boundaries' keys are catalogued
 * (boundary_runs / boundary_runs_pct), so they are NOT listed here. */
export function eligibleComposedRunSourceKeys(discipline) {
  if (discipline !== "batting") return [];
  const keys = [];
  for (const d of COMPOSED_RUNSOURCE_DIMS) {
    keys.push(makeComposedRunSourceKey(d.token, "runs"));
    keys.push(makeComposedRunSourceKey(d.token, "pct"));
  }
  return keys;
}

// ── Composed WICKET-TYPE × count/% columns (columns content rework D3) ─────────
// The "Wicket Type" composer generates, per dismissal type, a column that is EITHER
// the count of that type OR its share (%), via the Wave-C count/% toggle. Batting:
// the dismissal-KIND breakdown (12 kinds; % = share of the batter's dismissals) —
// REPLACES the enumerated batting Dismissals section (out_*/out_*_pct). Bowling: the
// bowler-credited wicket kinds (6; % = share of the bowler's wickets, a NEW %) —
// REPLACES the enumerated wkt_* columns. All enumerated defs stay in the catalogue
// (pop-up / filters / graph / advanced-conditions / presets still reference them).
//
// EQUIVALENCE GATE (Rule 1): batting count == out_<kind> and % == out_<kind>_pct
// byte-for-byte (same CASE tally over dismissal_kind, same /SUM(dismissed) share);
// bowling count == wkt_<kind> byte-for-byte (SUM(wickets_<col>)). The bowling %
// (SUM(wickets_<col>) * 100.0 / NULLIF(SUM(wickets), 0)) is NEW — a share of the
// bowler-credited wickets, which the six kinds partition exactly.
//
// KEY = `wt__<typeToken>__<axis>`  axis ∈ {count, pct}. Type tokens carry only single
// underscores (run_out, caught_and_bowled); no catalogued key starts with `wt__`;
// axis carries no underscore — split on the FIRST `__` after the prefix.
const COMPOSED_WICKETTYPE_PREFIX = "wt__";
const COMPOSED_WICKETTYPE_AXES = new Set(["count", "pct"]);
// Batting: token → { kind (dismissal_kind value), label, short } from DISMISSAL_KINDS
// (defined above) so the composed count/% labels stay identical to the retiring
// out_*/out_*_pct. Token = kind with spaces → underscores.
const _WT_BATTING = new Map(
  DISMISSAL_KINDS.map((d) => [d.kind.replace(/ /g, "_"), { kind: d.kind, label: d.label, short: d.short }])
);
// Bowling: the six bowler-credited kinds → { col (the wickets_<col> view column the
// wkt_* defs read), label, short } — reproducing the wkt_* display for the count side.
const _WT_BOWLING = new Map([
  ["bowled",            { col: "bowled",            label: "Bowled",          short: "Bowled" }],
  ["lbw",               { col: "lbw",               label: "LBW",             short: "LBW" }],
  ["caught",            { col: "caught",            label: "Caught",          short: "Caught" }],
  ["caught_and_bowled", { col: "caught_and_bowled", label: "Caught & Bowled", short: "c&b" }],
  ["stumped",           { col: "stumped",           label: "Stumped",         short: "Stumped" }],
  ["hit_wicket",        { col: "hit_wicket",        label: "Hit Wicket",      short: "Hit Wkt" }],
]);

/** Build the composed wicket-type column key for `typeToken` on `axis`. */
export function makeComposedWicketTypeKey(typeToken, axis) {
  return `${COMPOSED_WICKETTYPE_PREFIX}${typeToken}__${axis}`;
}
/** Parse a composed wicket-type column key → { token, axis }, or null. */
export function parseComposedWicketTypeKey(key) {
  if (typeof key !== "string" || !key.startsWith(COMPOSED_WICKETTYPE_PREFIX)) return null;
  const rest = key.slice(COMPOSED_WICKETTYPE_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return null;
  const token = rest.slice(0, sep);
  const axis = rest.slice(sep + 2);
  if (!COMPOSED_WICKETTYPE_AXES.has(axis)) return null;
  return { token, axis };
}
/** Build the VIRTUAL metric for a composed wicket-type column. Batting reproduces
 * out_<kind>/out_<kind>_pct exactly; bowling reproduces wkt_<kind> (count) + a share
 * of SUM(wickets) (%). source "innings" → projected by buildQuery like any metric. */
function buildComposedWicketTypeMetric(token, axis, discipline) {
  if (!COMPOSED_WICKETTYPE_AXES.has(axis)) return null;
  const key = makeComposedWicketTypeKey(token, axis);
  if (discipline === "batting") {
    const spec = _WT_BATTING.get(token);
    if (!spec) return null;
    const countSql = `SUM(CASE WHEN dismissal_kind = '${spec.kind}' THEN 1 ELSE 0 END)`;
    if (axis === "count") {
      return {
        key, baseToken: token, isComposedWicketType: true,
        label: spec.label, shortLabel: spec.short,
        discipline: "batting", source: "innings",
        sqlExpression: countSql,
        higherIsBetter: null, format: "int",
        isPhaseMetric: null, zeroIsData: true, additive: true, kind: "total",
      };
    }
    return {
      key, baseToken: token, isComposedWicketType: true,
      label: `${spec.label} %`, shortLabel: `${spec.short} %`,
      discipline: "batting", source: "innings",
      sqlExpression: `${countSql} * 100.0 / NULLIF(SUM(dismissed), 0)`,
      higherIsBetter: null, format: "pct1",
      isPhaseMetric: null, zeroIsData: false, kind: "percent",
    };
  }
  if (discipline === "bowling") {
    const spec = _WT_BOWLING.get(token);
    if (!spec) return null;
    const countSql = `SUM(wickets_${spec.col})`;
    if (axis === "count") {
      return {
        key, baseToken: token, isComposedWicketType: true,
        label: spec.label, shortLabel: spec.short,
        discipline: "bowling", source: "innings",
        sqlExpression: countSql,
        higherIsBetter: true, format: "int",
        isPhaseMetric: null, zeroIsData: true, additive: true, kind: "total",
      };
    }
    return {
      key, baseToken: token, isComposedWicketType: true,
      label: `${spec.label} %`, shortLabel: `${spec.short} %`,
      discipline: "bowling", source: "innings",
      sqlExpression: `${countSql} * 100.0 / NULLIF(SUM(wickets), 0)`,
      higherIsBetter: null, format: "pct1",
      isPhaseMetric: null, zeroIsData: false, kind: "percent",
    };
  }
  return null;
}
/** Resolve a composed wicket-type COLUMN key to its virtual metric, or null. Called
 * by getMetric. */
export function resolveComposedWicketTypeMetric(key, discipline) {
  const parsed = parseComposedWicketTypeKey(key);
  if (!parsed) return null;
  return buildComposedWicketTypeMetric(parsed.token, parsed.axis, discipline);
}
/** Every composed wicket-type column key for a discipline — folded into
 * eligibleColumnKeys so they survive a re-render. */
export function eligibleComposedWicketTypeKeys(discipline) {
  const tokens =
    discipline === "batting" ? [..._WT_BATTING.keys()]
    : discipline === "bowling" ? [..._WT_BOWLING.keys()]
    : [];
  const keys = [];
  for (const t of tokens) {
    keys.push(makeComposedWicketTypeKey(t, "count"));
    keys.push(makeComposedWicketTypeKey(t, "pct"));
  }
  return keys;
}

// ── Composed PARAMETRIC threshold columns (columns content rework D4, 2026-08-08)
// Innings Score Range (batting) + Wicket Haul (bowling): each generates a COLUMN =
// the COUNT of the player's innings whose per-innings quantity — batting: innings
// score (runs); bowling: wickets-in-an-innings — satisfies a user-chosen OPERATOR +
// VALUE(S): ≥ N, ≤ N, = N, or between N and M. This GENERALISES the enumerated
// `innings_score_ge` / `wicket_hauls_ge` (which are ≥ N only, with a fixed default N),
// which are now HIDDEN from the leaderboard picker (columnsPicker's core filter) but
// KEPT in the catalogue (the pop-up filter, paletteGroups, drawer's param HAVING path
// still reference them).
//
// EQUIVALENCE GATE (Rule 1): the ≥ N case is BYTE-IDENTICAL to the enumerated metric's
// sqlExpression at the same N — the builder DELEGATES the `ge` case to
// paramSqlExpression(base, N), the very function the enumerated column/filter already
// uses, so "Innings Score ≥ 100" reproduces innings_score_ge at N=100 char-for-char.
// The le/eq operators reuse the SAME per-innings quantity column (`paramColumn`:
// runs / wickets) in the SAME `SUM(CASE WHEN … THEN 1 ELSE 0 END)` shell; the between
// form is `col BETWEEN lo AND hi` (lo/hi order-normalised), matching the pop-up
// filter's own between-SQL (playerFiltersTab's conditionToInningsWhere) so a column
// and its filter agree.
//
// KEY = `<prefix>__<opToken>__<value(s)>` — opToken ∈ {ge, le, eq, bt}; value is a
// single non-negative integer, or `N_M` for between. prefix ∈ {isr (batting), wh
// (bowling)}: identifier-safe, self-encodes the discipline, and no catalogued key
// starts with `isr__` / `wh__` (verified) so `startsWith` is an unambiguous
// discriminator. The `_` inside a between value never clashes with the `__` field
// separator. Own-discipline only (never cross-discipline, like the D1–D3 composers).
const COMPOSED_PARAM_SPECS = {
  isr: { discipline: "batting", baseKey: "innings_score_ge", column: "runs", noun: "Innings Score", shortNoun: "Inns", sectionLabel: "Innings Score Range" },
  wh: { discipline: "bowling", baseKey: "wicket_hauls_ge", column: "wickets", noun: "Wicket Hauls", shortNoun: "Hauls", sectionLabel: "Wicket Haul" },
};
// opToken ⇄ the pop-up's OPERATORS key (advanced.js: gte/lte/eq/between) so the
// composer's operator <select> reuses the SAME operator vocabulary as the filter.
export const COMPOSED_PARAM_OP_TOKEN = { gte: "ge", lte: "le", eq: "eq", between: "bt" };
const _PARAM_OP_KEY = { ge: "gte", le: "lte", eq: "eq", bt: "between" };
const _PARAM_OP_SQL = { le: "<=", eq: "=" }; // `ge` delegates to paramSqlExpression; `bt` is BETWEEN
const _PARAM_OP_LABEL = { ge: "≥", le: "≤", eq: "=" };

/** Build the composed parametric column key. `values` = [N] for ge/le/eq, [N, M]
 * for bt (order-normalised so bt 50_30 and 30_50 make the same key). */
export function makeComposedParamKey(prefix, opToken, values) {
  if (opToken === "bt") {
    const lo = Math.min(Math.trunc(Number(values[0])), Math.trunc(Number(values[1])));
    const hi = Math.max(Math.trunc(Number(values[0])), Math.trunc(Number(values[1])));
    return `${prefix}__bt__${lo}_${hi}`;
  }
  return `${prefix}__${opToken}__${Math.trunc(Number(values[0]))}`;
}

/** Parse a composed parametric column key → { prefix, opToken, values }, or null.
 * Split on the FIRST `__` after the prefix (opToken carries no `__`); between values
 * split on the single `_`. Validates the op token + integer value shape. */
export function parseComposedParamKey(key) {
  if (typeof key !== "string") return null;
  for (const prefix of Object.keys(COMPOSED_PARAM_SPECS)) {
    const pfx = `${prefix}__`;
    if (!key.startsWith(pfx)) continue;
    const rest = key.slice(pfx.length);
    const sep = rest.indexOf("__");
    if (sep <= 0) return null;
    const opToken = rest.slice(0, sep);
    const valuePart = rest.slice(sep + 2);
    if (!(opToken in _PARAM_OP_KEY) || !valuePart) return null;
    const nums = valuePart.split("_").map((s) => Number(s));
    if (nums.some((n) => !Number.isInteger(n))) return null;
    if (opToken === "bt" ? nums.length !== 2 : nums.length !== 1) return null;
    return { prefix, opToken, values: nums };
  }
  return null;
}

/** Build the VIRTUAL metric for a composed parametric column, or null. The base
 * parametric metric supplies format / higherIsBetter / zeroIsData / additive / kind /
 * source ("innings"); the sqlExpression is generated operator-aware (ge delegates to
 * paramSqlExpression for byte-identity). `discipline` must match the prefix's own
 * discipline (isr→batting, wh→bowling) — so a wh__ key resolves to null on a batting
 * table and vice versa (own-discipline only, never cross). paramTemplate/param are
 * DROPPED: this is a concrete column, not itself re-parametrised. */
function buildComposedParamMetric(prefix, opToken, values, discipline) {
  const spec = COMPOSED_PARAM_SPECS[prefix];
  if (!spec || spec.discipline !== discipline) return null;
  if (!(opToken in _PARAM_OP_KEY)) return null;
  const base = getMetric(spec.baseKey, discipline);
  if (!base) return null;
  const min = base.param && base.param.min != null ? base.param.min : 0;
  const vs = values.map((v) => Math.max(min, Math.trunc(Number(v))));
  let sql, opLabel;
  if (opToken === "bt") {
    if (vs.length !== 2) return null;
    const lo = Math.min(vs[0], vs[1]);
    const hi = Math.max(vs[0], vs[1]);
    sql = `SUM(CASE WHEN ${spec.column} BETWEEN ${lo} AND ${hi} THEN 1 ELSE 0 END)`;
    opLabel = `${lo}–${hi}`;
  } else {
    const n = vs[0];
    // EQUIVALENCE: reproduce the enumerated metric's ≥ N sqlExpression exactly by
    // reusing its own paramSqlExpression; le/eq mirror that shape with the same column.
    sql = opToken === "ge"
      ? paramSqlExpression(base, n)
      : `SUM(CASE WHEN ${spec.column} ${_PARAM_OP_SQL[opToken]} ${n} THEN 1 ELSE 0 END)`;
    opLabel = `${_PARAM_OP_LABEL[opToken]} ${n}`;
  }
  return {
    key: makeComposedParamKey(prefix, opToken, vs),
    baseKey: spec.baseKey,
    isComposedParam: true,
    discipline: base.discipline,
    source: base.source, // "innings"
    sqlExpression: sql,
    label: `${spec.noun} ${opLabel}`,
    shortLabel: `${spec.shortNoun} ${opLabel}`,
    higherIsBetter: base.higherIsBetter,
    format: base.format, // "int"
    isPhaseMetric: base.isPhaseMetric, // null
    zeroIsData: base.zeroIsData, // true
    additive: base.additive, // true
    kind: base.kind, // "total"
  };
}

/** Resolve a composed parametric COLUMN key to its virtual metric, or null. Called
 * by getMetric (so resolveColumnMetric picks it up too — a param key is not a cross
 * key, so resolveColumnMetric falls through to getMetric). */
export function resolveComposedParamMetric(key, discipline) {
  const parsed = parseComposedParamKey(key);
  if (!parsed) return null;
  return buildComposedParamMetric(parsed.prefix, parsed.opToken, parsed.values, discipline);
}

/** True iff `key` is a VALID composed parametric column key for `discipline` (its
 * prefix's own discipline). Used by the column-prune sites (state.pruneIneligibleState,
 * table.pruneInvalidColumns) to keep a value-dynamic param
 * column alive across a re-render — these keys can't be enumerated into
 * eligibleColumnKeys' finite Set (infinite value space), so they're validated
 * structurally instead. Format-independent (Innings Score / Wicket Haul don't gate
 * on format). */
export function isParamComposedColumnKey(key, discipline) {
  const parsed = parseComposedParamKey(key);
  return !!parsed && COMPOSED_PARAM_SPECS[parsed.prefix].discipline === discipline;
}

/** Builder descriptor for the leaderboard picker's parametric composer (D4): the
 * section label + the numeric input's default / min / step / unit, derived from the
 * base metric's `param` so there is ONE source of truth. Returns null outside plain
 * batting/bowling. */
export function composedParamDescriptor(discipline) {
  const prefix = discipline === "batting" ? "isr" : discipline === "bowling" ? "wh" : null;
  if (!prefix) return null;
  const spec = COMPOSED_PARAM_SPECS[prefix];
  const base = getMetric(spec.baseKey, discipline);
  if (!base || !base.param) return null;
  return {
    prefix,
    sectionLabel: spec.sectionLabel,
    noun: spec.noun,
    unit: base.param.label, // "runs" / "wickets"
    default: base.param.default, // 50 / 4
    min: base.param.min ?? 0,
    step: base.param.step ?? 1,
  };
}

/** Composed-param PREFIX (isr / wh) for a base parametric metric key, or null.
 * The inverse of COMPOSED_PARAM_SPECS[prefix].baseKey — lets the parametric FILTER
 * find the count-column key scheme for the metric the user picked. */
function composedParamPrefixForBase(baseKey) {
  for (const [prefix, spec] of Object.entries(COMPOSED_PARAM_SPECS)) {
    if (spec.baseKey === baseKey) return prefix;
  }
  return null;
}

/**
 * EXISTENCE-gate HAVING for a PARAMETRIC threshold FILTER (Innings Score / Wicket
 * Hauls) — R2 (2026-08-09). The operator applies to the PER-INNINGS quantity
 * (runs / wickets) the user chose, and the filter is a pure existence gate: the
 * player has AT LEAST ONE innings whose quantity satisfies operator + value(s).
 * (This REPLACES the old count-of-qualifying-innings semantics — "≥3 innings of
 * 50+" — which had a separate score-threshold box plus a count operator/value.)
 *
 * It compiles to `((<count-column SQL for (op, values)>) >= 1)`, where the inner
 * SQL is generated by resolveComposedParamMetric — the SAME virtual-metric builder
 * the matching "<noun> [op] N" COUNT COLUMN uses. So a parametric filter and its
 * auto-added count column are BYTE-IDENTICAL by construction: existence == (that
 * column) >= 1, for EVERY operator (ge delegates to paramSqlExpression, le/eq are
 * the same SUM(CASE …) shell with <=/=, between is SUM(CASE … BETWEEN lo AND hi)).
 *
 * `operator` is an OPERATORS key (gte / lte / eq / between); `values` = [N] for
 * gte/lte/eq, [N, M] for between (order-normalised in the key). `discipline` is the
 * plain batting/bowling discipline (these metrics never exist in a matchup
 * namespace, so resolveComposedParamMetric returns null for any other discipline —
 * a dropped row, never a wrong number). Returns null on any invalid input
 * (missing/non-integer value, unknown operator, wrong value count, non-parametric
 * metric), so the caller (conditionToHaving) simply drops the condition.
 */
export function paramExistenceHaving(baseMetric, operator, values, discipline) {
  if (!baseMetric || !baseMetric.paramTemplate || !baseMetric.param) return null;
  const prefix = composedParamPrefixForBase(baseMetric.key);
  if (!prefix) return null;
  const opToken = COMPOSED_PARAM_OP_TOKEN[operator];
  if (!opToken) return null;
  const nums = (values || []).map((v) => parseInt(String(v).trim(), 10));
  if (nums.some((n) => !Number.isInteger(n))) return null;
  if (opToken === "bt" ? nums.length !== 2 : nums.length !== 1) return null;
  const countMetric = resolveComposedParamMetric(makeComposedParamKey(prefix, opToken, nums), discipline);
  if (!countMetric) return null;
  return `((${countMetric.sqlExpression}) >= 1)`;
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
 * R4-C: input precision for a numeric FILTER condition's value box, derived from
 * the metric's own `format` — display/input only, never touches sqlExpression or
 * the HAVING value itself. Counts (format "int" — runs, wickets, matches,
 * dismissals, PotM, innings…) stay integer (step 1); rates/averages/percentages
 * (format "dec1"/"dec2"/"pct1" — Strike Rate, Average, Economy, NBSR, any %…)
 * accept up to 2dp (step 0.01). "overs" is a raw SUM(balls) integer ball count
 * dressed up in O.B display notation (see the format doc above) — its filter
 * value is the same integer the query compares against, so it stays integer too.
 * ONE shared predicate — every numeric-condition surface (drawer, pop-up filter
 * editor) calls this instead of re-deriving the type.
 */
export function metricInputStep(metric) {
  const decimal = metric && (metric.format === "dec1" || metric.format === "dec2" || metric.format === "pct1");
  return decimal ? "0.01" : "1";
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

/**
 * Format-aware display label (Wave A1 item 4). The "(Innings)" suffix on
 * Best Bowling (plain + matchup) only makes sense when a multi-innings
 * format is in scope: FORMAT_BUCKETS' "Red Ball" (Test/MDM) is the only
 * bucket with real multiple-innings-per-match bowling; "50 Over" and "T20"
 * are single-innings, so the suffix would misread there. Rule: keep the
 * suffix iff `formats` includes "Red Ball" (including mixed scopes, where
 * multi-innings figures genuinely exist alongside single-innings ones);
 * strip it otherwise. Display-only — metric.label/key/sqlExpression/
 * sortExpression are untouched; this is read at render time by callers that
 * need the resolved text instead of `metric.label` directly. Generic on any
 * "… (Innings)"-suffixed label (not hard-coded to the `best` key), though
 * today only Best Bowling carries the suffix.
 */
export function metricDisplayLabel(metric, formats) {
  if (!metric || !metric.label) return metric ? metric.label : metric;
  if (metric.label.endsWith(" (Innings)") && !(formats || []).includes("Red Ball")) {
    return metric.label.slice(0, -" (Innings)".length);
  }
  return metric.label;
}

// ── Filter-rejig Wave R1 additions ────────────────────────────────────────────
// A builder for the parametrised threshold metrics, plus the Innings Number
// scope-filter descriptor. Both are consumed by Wave R2's filter UI (drawer.js /
// filters.js); defined here so the number-critical logic lives with the catalogue
// and R2 does display/wiring only (numbers sacred — R2 changes no aggregate).

/**
 * Concrete aggregate SQL for a PARAMETRISED threshold metric (Innings Score ≥ N,
 * Wicket Hauls ≥ N) at a caller-supplied integer N. Such metrics carry a
 * `paramTemplate` (the aggregate with a `{N}` token) and a `param` descriptor.
 * This substitutes a VALIDATED integer (truncated, clamped to param.min), so the
 * returned string is always a plain SQL aggregate with an integer literal — there
 * is no injection surface. A non-integer / missing N, or a non-parametrised
 * metric, falls back to the metric's own DEFAULT `sqlExpression`. Wave R2's filter
 * code calls this to build the HAVING expression once the user picks N; until
 * then table.js interpolates the default sqlExpression verbatim (a valid, correct
 * fixed-N count — N = 50 for Innings Score, 4 for Wicket Hauls).
 */
export function paramSqlExpression(metric, n) {
  if (!metric || !metric.paramTemplate || !metric.param) {
    return metric ? metric.sqlExpression : null;
  }
  const raw = Math.trunc(Number(n));
  if (!Number.isFinite(raw)) return metric.sqlExpression;
  const v = Math.max(metric.param.min ?? 0, raw);
  return metric.paramTemplate.split(metric.param.token).join(String(v));
}

/**
 * Innings Number scope-filter descriptor (filter-rejig Wave R1). NOT an aggregate
 * metric — it narrows WHICH innings are in scope (a WHERE predicate on the
 * batting_innings / bowling_innings view's `innings_number` column), so Wave R2's
 * filter code (filters.js) owns the wiring; this is the single verified source of
 * the number-critical mapping, replacing the old batted-first / chased "Innings
 * Order" concept.
 *
 * CRITICAL: `innings_number` in the views is 0-BASED (verified against the ball
 * layer — values 0..1 for white-ball formats, 0..3 for red-ball). Display
 * "Innings 1" is stored `innings_number = 0`, so stored = display − 1
 * (`toStored`). The column is discipline-aware by construction: on batting_innings
 * it is the innings the batter batted in, on bowling_innings the innings the
 * bowler bowled in — so a plain `innings_number = toStored(value)` predicate over
 * the active discipline's view already means "the innings the player batted /
 * bowled in", with no extra handling.
 */
export const INNINGS_NUMBER_FILTER = {
  column: "innings_number",
  zeroBased: true,
  toStored: (displayN) => Number(displayN) - 1,
  whiteBall: [1, 2],       // T20 / IT20 / ODI / ODM: two innings per match
  redBall: [1, 2, 3, 4],   // Test / MDM: up to four innings per match
};
