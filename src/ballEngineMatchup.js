// src/ballEngineMatchup.js
//
// Ball-grain rebuild — Wave 2b (owner decision 67). Generates the SQL that
// RECONSTRUCTS the matchup-grain `matchup_batting` / `matchup_bowling` views
// from the six delivery ("ball layer") parquet files joined to the `profiles`
// view (player_profiles.parquet), so the browser computes every matchup number
// natively from raw balls with NO change to the query builders or the metric
// catalogue.
//
// ── Why this file exists (the architecture) ─────────────────────────────────
// Approach B (decision 67), the exact mirror of src/ballEngine.js for the plain
// views: keep src/table.js's buildMatchupQuery, src/metrics.js's matchup
// namespaces and src/filters.js BYTE-IDENTICAL. The entire swap lives in the
// view definition — behind the ?engine=ball flag (config.js ballEngineEnabled()),
// db.js points the `matchup_batting` / `matchup_bowling` views at THIS module's
// output instead of at matchup_batting.parquet / matchup_bowling.parquet. Every
// downstream matchup query is then identical by construction, because the
// reconstruction is proven BYTE-IDENTICAL to the shipped matchup exports.
//
// ── Provenance (do not "improve" the SQL) ───────────────────────────────────
// Faithful port of export_parquet.py's `run_ball_layer_gates()` oracle
// (orx_mbat / orx_mbowl), which the pipeline reconciles CELL-BY-CELL against the
// shipped matchup parquets on every build (0 mismatches — matchup_batting
// 964,860 rows / 74 cols, matchup_bowling 1,354,907 / 66). Two additions the
// oracle carries as helper-only, required to make the VIEW byte-identical to the
// EXPORT (not merely gate-passing), exactly as ballEngine.js does for the plain
// views:
//   1. odi_* columns are NULL for The Hundred (balls_per_over = 5), as
//      sql_matchup_batting()/sql_matchup_bowling() wrap them; the oracle instead
//      carried 0 and compared only non-Hundred rows.
//   2. Every output column is CAST to the shipped parquet's exact type (counts
//      DOUBLE, keys VARCHAR/INTEGER, batting_position BIGINT, team_rel_* FLOAT),
//      so the reconstructed view is a drop-in for the export parquet.
// Verified in a native DuckDB reconciliation of THIS module's full-schema output
// against both shipped matchup parquets: 0 bad cells, 0 missing/invented keys.
//
// ── Grain note (NOT the plain crease union) ─────────────────────────────────
// A matchup row is per-FACED-ball-vs-style: matchup_batting groups the striker's
// balls by the bowler's mapped style; matchup_bowling groups the bowler's balls
// by the striker's hand AND the striker's batting_position. A batter who faced 0
// balls has NO matchup row — there is NO zero-ball appearance recovery here
// (that was plain-batting only). The `(unmapped)` bucket (bowler/striker with no
// profile) IS produced — it is the coverage denominator ("N of M balls"). Women
// have no profiles, so every women's ball maps to `(unmapped)`; the app greys
// the Vs surface for women, so those rows stay honestly empty.
//
// ── Profile join (men-only in practice) ─────────────────────────────────────
// matchup_batting keys on the BOWLER's style:
//   COALESCE(profiles.bowling_type, profiles.bowling_group, '(unmapped)').
// matchup_bowling keys on the STRIKER's hand:
//   COALESCE(profiles.batting_style, '(unmapped)').
// The `profiles` view is one row per player_id (SPEC §4.2), so the LEFT JOIN
// never multiplies ball rows — the same assumption the exporter makes.
//
// ── Query-shaped reconstruction + lean base (Layer 1 + 2) ───────────────────
// Same two levers as ballEngine.js. `buildMatchupViewSql` takes a `columns`
// option (the matchup-grain output columns to emit) and generates ONLY those
// aggregates and ONLY the CTEs they need: `tta`/`thp` (team-relative
// denominators) only when a team_rel_* column is asked for; the wickets_extra
// LIST is projected into the base only when a dis_*/wkt_* kind-split column is
// asked for. `columns` omitted/null = the FULL export schema. The lean base
// projection is derived by token-scanning this module's OWN generated SQL
// against DELIVERY_COLUMNS (over-inclusion is harmless, under-inclusion is
// impossible — none of the generated SQL uses a star expansion).
//
//   ROW-SET RULE: COLUMN PRUNING removes COLUMNS ONLY. The matchup grain (mb /
//   mbowl GROUP BY) and the base WHERE (super overs excluded, striker/bowler NOT
//   NULL) are built identically whatever is pruned, so no COUNT(*) ever moves.
//   THE WINDOW is the deliberate exception (Wave 3, decision 67): windowPredicate
//   AND-composes into the base ball WHERE, so the matchup grain is built over the
//   IN-WINDOW balls — exactly the (batter × style) / (bowler × hand × position)
//   rows with ≥1 in-window ball, and their in-window runs/balls/wickets/coverage.
//
// ── windowPredicate / playerPredicate (hooks) ───────────────────────────────
// windowPredicate is the Wave-3 delivery-window filter (src/deliveryWindow.js) —
// LIVE: db.js pushes it in from the active state.deliveryWindow (batting views get
// the bat_ball clock, bowling views the bowl_ball clock). "" when no window ⇒
// byte-identical to today. playerPredicate is db.js's popup single-player base
// filter (batter_id/bowler_id equality), byte-identical only for player-LOCAL
// matchup columns (db.js gates it on ballColumns' whole-innings rule — never
// emitted when a team_rel_* column is needed). Both AND into the base ball WHERE
// and read SOURCE columns, so neither needs a projection entry.

import { DELIVERY_COLUMNS, sqlIdentifierTokens, viewColumnsFor, alwaysColumnsFor, GRAIN_SPLIT_COLUMNS } from "./ballColumns.js";

// ── SPEC §4.1 calc fragments (verbatim from ballEngine.js / SPEC §4.1) ───────
// Bare column names resolve to the ball table; profiles shares none of them.
const FACED = "wides IS NULL"; // batter faced a ball (no-balls count as faced)
const LEGAL = "wides IS NULL AND noballs IS NULL"; // bowler legal ball
const B4 = "runs_batter = 4 AND is_not_boundary IS NOT TRUE"; // boundary four
const B6 = "runs_batter = 6 AND is_not_boundary IS NOT TRUE"; // boundary six
const BRUNS = "runs_batter + COALESCE(noballs,0) + COALESCE(wides,0)"; // bowler-charged runs

const T20P =
  "CASE WHEN balls_per_over=5 THEN " +
  "CASE WHEN team_ball BETWEEN 1 AND 25 THEN 'pp' " +
  "WHEN team_ball BETWEEN 26 AND 75 THEN 'mid' " +
  "WHEN team_ball >= 76 THEN 'death' END " +
  "WHEN over_number BETWEEN 0 AND 5 THEN 'pp' " +
  "WHEN over_number BETWEEN 6 AND 14 THEN 'mid' " +
  "WHEN over_number BETWEEN 15 AND 19 THEN 'death' END";
const ODIP =
  "CASE WHEN balls_per_over=5 THEN NULL " +
  "WHEN over_number BETWEEN 0 AND 9 THEN 'pp' " +
  "WHEN over_number BETWEEN 10 AND 39 THEN 'mid' " +
  "WHEN over_number BETWEEN 40 AND 49 THEN 'death' END";

const PHASES = ["pp", "mid", "death"];
const PHASE_FAMILIES = [
  [T20P, ""],
  [ODIP, "odi_"],
];

/** Per-ball count of a bowler-credited wicket `kind` across the flat wicket_kind
 * column PLUS the wickets_extra overflow list. A SCALAR list_filter/len per row —
 * never a `FROM b, UNNEST(...)` (the 6 s/use WASM trap). */
function kindct(kind) {
  const k = kind.replace(/'/g, "''");
  return (
    `((CASE WHEN wicket_kind = '${k}' THEN 1 ELSE 0 END)` +
    ` + COALESCE(len(list_filter(wickets_extra, x -> x.kind = '${k}')), 0))`
  );
}

/** `read_parquet([...])` over the given registered ball-file names. */
function sourceExpr(files) {
  return `read_parquet([${files.map((f) => `'${f}'`).join(", ")}])`;
}

/** `name AS (body)` CTE text. */
function cte(name, body) {
  return `${name} AS (${body})`;
}

/** `expr AS alias` select-list items from a {alias: expr} map, restricted to
 * `keys`, in `keys` order. */
function selectFrom(map, keys) {
  return keys.map((k) => `${map[k]} AS ${k}`);
}

/** `year` / `month` are DuckDB parser keywords — the export schema quotes them,
 * so the reconstruction must too. */
function quoteIdent(name) {
  return name === "year" || name === "month" ? `"${name}"` : name;
}

/** The base-CTE tail: `WHERE NOT is_super_over AND <involved> IS NOT NULL` plus
 * the optional pushed-down predicates. All read the SOURCE ball rows (they need
 * no entry in the lean projection).
 *
 *   scopePredicate  — the query's CORE-SCOPE ball filter (gender / match_type /
 *     team_type / match_date), lifted verbatim by db.js. Byte-identical: those
 *     columns are constant within a (match_id, innings_number), so filtering
 *     balls by them keeps every ball of every in-scope innings and drops only
 *     whole out-of-scope innings the outer WHERE discards anyway. The memory +
 *     row-group/file pruning lever.
 *   windowPredicate — Wave-3 delivery-window filter (src/deliveryWindow.js),
 *     pushed by db.js from the active state.deliveryWindow. "" when no window
 *     (byte-identical); when present it restricts the base to the in-window balls
 *     (decision 67 — the intended row-set change; see the ROW-SET RULE header).
 *   playerPredicate — db.js's popup single-player base filter. EMPTY for every
 *     whole-scope query; byte-identical only for player-LOCAL columns (gated by
 *     db.js on ballColumns' whole-innings rule). */
function baseWhere(involvedCol, scopePredicate, windowPredicate, playerPredicate) {
  let sql = `NOT b0.is_super_over AND b0.${involvedCol} IS NOT NULL`;
  const sp = (scopePredicate || "").trim();
  if (sp) sql += ` AND (${sp})`;
  const wp = (windowPredicate || "").trim();
  if (wp) sql += ` AND (${wp})`;
  const pp = (playerPredicate || "").trim();
  if (pp) sql += ` AND (${pp})`;
  return sql;
}

/**
 * Stitch the profile-joined base CTE onto the emitted CTEs + final SELECT,
 * deriving the LEAN base projection (Layer 2) from the generated SQL itself:
 * every DELIVERY_COLUMNS name that appears as an identifier token downstream of
 * `b` is projected from the ball source `b0`, and nothing else. The derived
 * style key(s) (`styleSelect`) are computed here from the joined profile row and
 * are ALWAYS present. The base WHERE + JOIN read `is_super_over`, the involved
 * id and the join id straight off `b0`, so those need no projection entry.
 *
 * @param {"matchup_batting"|"matchup_bowling"} discipline
 */
function assemble(discipline, files, scopePredicate, windowPredicate, playerPredicate, cteSql, finalSql) {
  const joinIdCol = discipline === "matchup_batting" ? "bowler_id" : "batter_id";
  const involvedCol = discipline === "matchup_batting" ? "batter_id" : "bowler_id";
  const styleSelect =
    discipline === "matchup_batting"
      ? "COALESCE(pp.bowling_type, pp.bowling_group, '(unmapped)') AS bowling_type,\n" +
        "         COALESCE(pp.bowling_group, '(unmapped)') AS bowling_group"
      : "COALESCE(pp.batting_style, '(unmapped)') AS batting_hand";

  const body = `${cteSql}\n${finalSql}`;
  const toks = sqlIdentifierTokens(body);
  const baseCols = DELIVERY_COLUMNS.filter((c) => toks.has(c));
  const proj = baseCols.map((c) => (c === "year" || c === "month" ? `b0."${c}" AS "${c}"` : `b0.${c}`));

  // vs-PotMs axis (Cutover S1, decision 81). Added to the base ONLY when the mb/
  // mbowl CTEs reference `vs_potm` (i.e. the query named it — the potm axis is on),
  // so an ordinary reconstruction is byte-identical. The PotM source is the app's
  // `player_matches` view (player_of_match 0/1 — buildPomCteSql's source); the
  // DISTINCT (match, PotM winner) set is EXACTLY the export's
  // `match_player_of_match WHERE player_id IS NOT NULL` (sql_player_matches builds
  // player_of_match=1 from it), PK (match, player) → at most one row per opponent,
  // so the LEFT JOIN never multiplies a ball. The join id is the OPPONENT id — the
  // SAME `joinIdCol` the profile join uses (bowler_id for batting, batter_id for
  // bowling) — so the identity join self-restricts to opposition PotMs (a same-team
  // PotM is never that delivery's opponent). vs_potm is VARCHAR '1'/'0' so the
  // bucketClause `vs_potm = '1'` is a clean string comparison, exactly like the
  // other bucket dims (bowling_type/batting_hand); flag-off never reads it.
  const needPotm = toks.has("vs_potm");
  const potmSelect = needPotm
    ? ",\n         CASE WHEN pomj.player_id IS NOT NULL THEN '1' ELSE '0' END AS vs_potm"
    : "";
  const potmJoin = needPotm
    ? "\n    LEFT JOIN (SELECT DISTINCT match_id, player_id FROM player_matches WHERE player_of_match = 1) pomj" +
      `\n           ON pomj.match_id = b0.match_id AND pomj.player_id = b0.${joinIdCol}`
    : "";

  const base =
    `b AS (\n    SELECT ${proj.join(", ")},\n         ${styleSelect}${potmSelect}\n` +
    `    FROM ${sourceExpr(files)} b0\n` +
    `    LEFT JOIN profiles pp ON pp.player_id = b0.${joinIdCol}${potmJoin}\n` +
    `    WHERE ${baseWhere(involvedCol, scopePredicate, windowPredicate, playerPredicate)})`;

  return `\nWITH ${base},\n${cteSql}\n${finalSql}`;
}

/**
 * Resolve the requested `columns` option into the Set of output columns to emit.
 * `null`/undefined = the full export schema. The keys + denormalised context
 * (alwaysColumnsFor) are ALWAYS added. Unknown names are ignored.
 */
function wantedColumns(discipline, columns) {
  const vocab = viewColumnsFor(discipline);
  // The full/default set is the EXPORT grain: exclude GRAIN-SPLITTING columns
  // (vs_potm — decision 81) so a star-expansion reconstruction keeps the
  // (…, bowling_type)/(…, batting_position) row set byte-identical. They are still
  // emitted when EXPLICITLY named (the branch below), i.e. when the potm axis is on.
  if (!columns) return new Set(vocab.filter((c) => !GRAIN_SPLIT_COLUMNS.has(c)));
  const want = new Set(alwaysColumnsFor(discipline));
  const known = new Set(vocab);
  for (const c of columns) if (known.has(c)) want.add(c);
  return want;
}

// ── matchup_batting reconstruction ───────────────────────────────────────────

/** The per-(match, innings, batter, bowling_type) numeric aggregates the `mb`
 * CTE can emit, keyed by the output column they feed. Expressions verbatim from
 * the proven oracle (orx_mbat) / SPEC §4.1 — pruning selects among them. */
function matchupBattingAggregates() {
  const m = {
    runs: "SUM(runs_batter)",
    balls_faced: `SUM(CASE WHEN ${FACED} THEN 1 ELSE 0 END)`,
    dots: `SUM(CASE WHEN ${FACED} AND runs_batter=0 THEN 1 ELSE 0 END)`,
    fours_hit: `SUM(CASE WHEN ${B4} THEN 1 ELSE 0 END)`,
    sixes_hit: `SUM(CASE WHEN ${B6} THEN 1 ELSE 0 END)`,
    dismissals: "SUM(bowler_credited_wkts)",
    dis_bowled: `SUM(${kindct("bowled")})`,
    dis_lbw: `SUM(${kindct("lbw")})`,
    dis_caught: `SUM(${kindct("caught")})`,
    dis_caught_and_bowled: `SUM(${kindct("caught and bowled")})`,
    dis_stumped: `SUM(${kindct("stumped")})`,
    dis_hit_wicket: `SUM(${kindct("hit wicket")})`,
    ones: `SUM(CASE WHEN ${FACED} AND runs_batter=1 THEN 1 ELSE 0 END)`,
    twos: `SUM(CASE WHEN ${FACED} AND runs_batter=2 THEN 1 ELSE 0 END)`,
    threes: `SUM(CASE WHEN ${FACED} AND runs_batter=3 THEN 1 ELSE 0 END)`,
    fives: `SUM(CASE WHEN ${FACED} AND runs_batter=5 THEN 1 ELSE 0 END)`,
    nb_fours: "SUM(CASE WHEN runs_batter=4 AND is_not_boundary IS TRUE THEN 1 ELSE 0 END)",
    nb_sixes: "SUM(CASE WHEN runs_batter=6 AND is_not_boundary IS TRUE THEN 1 ELSE 0 END)",
    non_boundary_runs:
      `SUM(runs_batter) - 4*SUM(CASE WHEN ${B4} THEN 1 ELSE 0 END)` +
      ` - 6*SUM(CASE WHEN ${B6} THEN 1 ELSE 0 END)`,
  };
  for (const [p, pref] of PHASE_FAMILIES) {
    for (const ph of PHASES) {
      m[`${pref}${ph}_runs`] = `SUM(CASE WHEN (${p})='${ph}' THEN runs_batter ELSE 0 END)`;
      m[`${pref}${ph}_balls`] = `SUM(CASE WHEN (${p})='${ph}' AND ${FACED} THEN 1 ELSE 0 END)`;
      m[`${pref}${ph}_dots`] = `SUM(CASE WHEN (${p})='${ph}' AND ${FACED} AND runs_batter=0 THEN 1 ELSE 0 END)`;
      m[`${pref}${ph}_fours`] = `SUM(CASE WHEN (${p})='${ph}' AND ${B4} THEN 1 ELSE 0 END)`;
      m[`${pref}${ph}_sixes`] = `SUM(CASE WHEN (${p})='${ph}' AND ${B6} THEN 1 ELSE 0 END)`;
      // Matchup phase dismissals = bowler-CREDITED wickets in the phase (decision
      // 23 / backlog #3) — a per-ball SUM, no wickets_extra unnest needed.
      m[`${pref}${ph}_dismissals`] = `SUM(CASE WHEN (${p})='${ph}' THEN bowler_credited_wkts ELSE 0 END)`;
    }
  }
  return m;
}

/** Team-innings-vs-type totals (the denominators behind team_rel_*). Emitted as
 * a block (five SUMs over one GROUP BY) only when a team_rel_* column is asked. */
function matchupBattingTeamAggregates() {
  return {
    t_balls: `SUM(CASE WHEN ${FACED} THEN 1 ELSE 0 END)`,
    t_runs: `SUM(CASE WHEN ${FACED} THEN runs_batter ELSE 0 END)`,
    t_dots: `SUM(CASE WHEN ${FACED} AND runs_batter=0 THEN 1 ELSE 0 END)`,
    t_fours: `SUM(CASE WHEN ${B4} THEN 1 ELSE 0 END)`,
    t_sixes: `SUM(CASE WHEN ${B6} THEN 1 ELSE 0 END)`,
  };
}

function matchupBattingViewSql(files, scopePredicate, windowPredicate, playerPredicate, columns) {
  const want = wantedColumns("matchup_batting", columns);
  const has = (c) => want.has(c);
  const plain = (col) => `CAST(mb.${col} AS DOUBLE)`;
  const odi = (col) => `CAST(CASE WHEN mb.is_hundred=1 THEN NULL ELSE mb.${col} END AS DOUBLE)`;

  // ── output-column → { sql, mb:[aggregate aliases], tta, pos } ──────────────
  const OUT = {
    match_id: { sql: "mb.match_id" },
    innings_number: { sql: "CAST(mb.innings_number AS INTEGER)" },
    batter_id: { sql: "mb.batter_id" },
    bowling_type: { sql: "mb.bowling_type" },
    bowling_group: { sql: "mb.bowling_group" },
    // vs-PotMs axis (decision 81): a grouping key on the split grain (VARCHAR
    // '1'/'0'), never an aggregate — no `mb:` dependency. Present in `mb` only
    // when needPotm below adds it to the CTE's GROUP BY.
    vs_potm: { sql: "mb.vs_potm" },
    batter_name: { sql: "mb.batter_name" },
    batting_team: { sql: "mb.batting_team" },
    bowling_team: { sql: "mb.bowling_team" },
    match_type: { sql: "mb.match_type" },
    gender: { sql: "mb.gender" },
    team_type: { sql: "mb.team_type" },
    match_date: { sql: "mb.match_date" },
    year: { sql: 'CAST(mb."year" AS INTEGER)' },
    month: { sql: 'CAST(mb."month" AS INTEGER)' },
    batting_position: { sql: "CAST(mb.batting_position AS BIGINT)", pos: true },
    team_rel_sr: {
      sql:
        `CAST((mb.runs / NULLIF(mb.balls_faced,0) * 100.0)` +
        ` - (tta.t_runs / NULLIF(tta.t_balls,0) * 100.0) AS FLOAT)`,
      mb: ["runs", "balls_faced"],
      tta: true,
    },
    team_rel_dot_pct: {
      sql:
        `CAST((mb.dots / NULLIF(mb.balls_faced,0) * 100.0)` +
        ` - (tta.t_dots / NULLIF(tta.t_balls,0) * 100.0) AS FLOAT)`,
      mb: ["dots", "balls_faced"],
      tta: true,
    },
    team_rel_bpb: {
      sql:
        `CAST((mb.balls_faced / NULLIF(mb.fours_hit+mb.sixes_hit,0))` +
        ` - (tta.t_balls / NULLIF(tta.t_fours+tta.t_sixes,0)) AS FLOAT)`,
      mb: ["balls_faced", "fours_hit", "sixes_hit"],
      tta: true,
    },
    team_rel_nbsr: {
      sql:
        `CAST((mb.non_boundary_runs / NULLIF(mb.balls_faced-mb.fours_hit-mb.sixes_hit,0) * 100.0)` +
        ` - ((tta.t_runs-4*tta.t_fours-6*tta.t_sixes) / NULLIF(tta.t_balls-tta.t_fours-tta.t_sixes,0) * 100.0) AS FLOAT)`,
      mb: ["non_boundary_runs", "balls_faced", "fours_hit", "sixes_hit"],
      tta: true,
    },
  };
  // Straight DOUBLE pass-throughs of one `mb` aggregate.
  for (const col of [
    "runs", "balls_faced", "dots", "fours_hit", "sixes_hit", "dismissals",
    "dis_bowled", "dis_lbw", "dis_caught", "dis_caught_and_bowled", "dis_stumped", "dis_hit_wicket",
    "ones", "twos", "threes", "fives", "nb_fours", "nb_sixes", "non_boundary_runs",
  ]) {
    OUT[col] = { sql: plain(col), mb: [col] };
  }
  // Per-phase columns: T20 family plain, ODI family NULL-for-The-Hundred.
  for (const ph of PHASES) {
    for (const kind of ["runs", "balls", "dots", "fours", "sixes", "dismissals"]) {
      OUT[`${ph}_${kind}`] = { sql: plain(`${ph}_${kind}`), mb: [`${ph}_${kind}`] };
      OUT[`odi_${ph}_${kind}`] = { sql: odi(`odi_${ph}_${kind}`), mb: [`odi_${ph}_${kind}`] };
    }
  }

  // ── resolve dependencies ──────────────────────────────────────────────────
  const emitted = viewColumnsFor("matchup_batting").filter(has);
  const needMb = new Set();
  let needTta = false;
  let needPos = false;
  for (const col of emitted) {
    const spec = OUT[col];
    if (spec.mb) for (const a of spec.mb) needMb.add(a);
    if (spec.tta) needTta = true;
    if (spec.pos) needPos = true;
  }
  const needHundred = emitted.some((c) => c.startsWith("odi_"));

  // ── CTEs ──────────────────────────────────────────────────────────────────
  const ctes = [];
  if (needTta) {
    const tAgg = matchupBattingTeamAggregates();
    ctes.push(
      cte(
        "tta",
        `SELECT match_id, innings_number, bowling_type,\n                ` +
          selectFrom(tAgg, Object.keys(tAgg)).join(",\n                ") +
          `\n         FROM b GROUP BY 1,2,3`
      )
    );
  }
  // vs-PotMs axis (decision 81): when vs_potm is emitted, it is added to the mb
  // GROUP BY so each (match,inn,batter,bowling_type) group splits into finer
  // vs_potm='1'/'0' buckets — exactly the export's M2b grain change. Rolling the
  // split back up (potm axis off ⇒ vs_potm not emitted ⇒ NOT in the GROUP BY)
  // reproduces every pre-M2b column byte-identically. tta is LEFT at the old grain
  // (mirrors the export: team_type_agg is not split by vs_potm).
  const needPotm = has("vs_potm");
  const mbAgg = matchupBattingAggregates();
  const mbKeys = Object.keys(mbAgg).filter((k) => needMb.has(k));
  const mbBody =
    `SELECT match_id, innings_number, batter_id, bowling_type,${needPotm ? " vs_potm," : ""}\n` +
    `                ANY_VALUE(bowling_group) bowling_group, ANY_VALUE(batter_name) batter_name,\n` +
    `                ANY_VALUE(batting_team) batting_team, ANY_VALUE(bowling_team) bowling_team,\n` +
    `                ANY_VALUE(match_type) match_type, ANY_VALUE(gender) gender,\n` +
    `                ANY_VALUE(team_type) team_type, ANY_VALUE(match_date) match_date,\n` +
    `                ANY_VALUE(year) AS "year", ANY_VALUE(month) AS "month"` +
    (needPos ? `,\n                ANY_VALUE(batting_position) batting_position` : "") +
    (needHundred ? `,\n                MAX(CASE WHEN balls_per_over=5 THEN 1 ELSE 0 END) is_hundred` : "") +
    (mbKeys.length ? `,\n                ` + selectFrom(mbAgg, mbKeys).join(",\n                ") : "") +
    `\n         FROM b GROUP BY match_id, innings_number, batter_id, bowling_type${needPotm ? ", vs_potm" : ""}`;
  ctes.push(cte("mb", mbBody));

  // ── final SELECT ──────────────────────────────────────────────────────────
  const selectList = emitted.map((col) => `${OUT[col].sql} AS ${quoteIdent(col)}`);
  const joins = ["FROM mb"];
  if (needTta) {
    joins.push(
      "LEFT JOIN tta ON tta.match_id=mb.match_id AND tta.innings_number=mb.innings_number AND tta.bowling_type=mb.bowling_type"
    );
  }
  const finalSql = `SELECT\n    ${selectList.join(",\n    ")}\n${joins.join("\n")}`;
  return assemble("matchup_batting", files, scopePredicate, windowPredicate, playerPredicate, ctes.join(",\n"), finalSql);
}

// ── matchup_bowling reconstruction ───────────────────────────────────────────

const WICKET_KIND_COLUMNS = {
  wkt_bowled: "bowled",
  wkt_lbw: "lbw",
  wkt_caught: "caught",
  wkt_caught_and_bowled: "caught and bowled",
  wkt_stumped: "stumped",
  wkt_hit_wicket: "hit wicket",
};

/** The per-(match, innings, bowler, batting_hand, batting_position) aggregates
 * the `mbowl` CTE can emit. Verbatim from orx_mbowl / SPEC §4.1. */
function matchupBowlingAggregates() {
  const m = {
    balls: `SUM(CASE WHEN ${LEGAL} THEN 1 ELSE 0 END)`,
    runs_conceded: `SUM(${BRUNS})`,
    wickets: "SUM(bowler_credited_wkts)",
    dots: `SUM(CASE WHEN ${LEGAL} AND runs_batter=0 THEN 1 ELSE 0 END)`,
    fours_conceded: `SUM(CASE WHEN ${B4} THEN 1 ELSE 0 END)`,
    sixes_conceded: `SUM(CASE WHEN ${B6} THEN 1 ELSE 0 END)`,
  };
  for (const [col, kind] of Object.entries(WICKET_KIND_COLUMNS)) {
    m[col] = `SUM(${kindct(kind)})`;
  }
  for (const [p, pref] of PHASE_FAMILIES) {
    for (const ph of PHASES) {
      m[`${pref}${ph}_balls`] = `SUM(CASE WHEN (${p})='${ph}' AND ${LEGAL} THEN 1 ELSE 0 END)`;
      m[`${pref}${ph}_runs_conceded`] = `SUM(CASE WHEN (${p})='${ph}' THEN ${BRUNS} ELSE 0 END)`;
      m[`${pref}${ph}_wickets`] = `SUM(CASE WHEN (${p})='${ph}' THEN bowler_credited_wkts ELSE 0 END)`;
      m[`${pref}${ph}_dots`] = `SUM(CASE WHEN (${p})='${ph}' AND ${LEGAL} AND runs_batter=0 THEN 1 ELSE 0 END)`;
      m[`${pref}${ph}_fours_conceded`] = `SUM(CASE WHEN (${p})='${ph}' AND ${B4} THEN 1 ELSE 0 END)`;
      m[`${pref}${ph}_sixes_conceded`] = `SUM(CASE WHEN (${p})='${ph}' AND ${B6} THEN 1 ELSE 0 END)`;
    }
  }
  return m;
}

/** Team-innings-vs-(hand,position) totals — the team_rel_* denominators. */
function matchupBowlingTeamAggregates() {
  return {
    t_balls: `SUM(CASE WHEN ${LEGAL} THEN 1 ELSE 0 END)`,
    t_runs: `SUM(${BRUNS})`,
    t_dots: `SUM(CASE WHEN ${LEGAL} AND runs_batter=0 THEN 1 ELSE 0 END)`,
    t_wkts: "SUM(bowler_credited_wkts)",
  };
}

function matchupBowlingViewSql(files, scopePredicate, windowPredicate, playerPredicate, columns) {
  const want = wantedColumns("matchup_bowling", columns);
  const has = (c) => want.has(c);
  const plain = (col) => `CAST(mbowl.${col} AS DOUBLE)`;
  const odi = (col) => `CAST(CASE WHEN mbowl.is_hundred=1 THEN NULL ELSE mbowl.${col} END AS DOUBLE)`;

  const OUT = {
    match_id: { sql: "mbowl.match_id" },
    innings_number: { sql: "CAST(mbowl.innings_number AS INTEGER)" },
    bowler_id: { sql: "mbowl.bowler_id" },
    batting_hand: { sql: "mbowl.batting_hand" },
    batting_position: { sql: "CAST(mbowl.batting_position AS BIGINT)" },
    // vs-PotMs axis (decision 81): grouping key on the split grain (VARCHAR '1'/'0').
    vs_potm: { sql: "mbowl.vs_potm" },
    bowler_name: { sql: "mbowl.bowler_name" },
    batting_team: { sql: "mbowl.batting_team" },
    bowling_team: { sql: "mbowl.bowling_team" },
    match_type: { sql: "mbowl.match_type" },
    gender: { sql: "mbowl.gender" },
    team_type: { sql: "mbowl.team_type" },
    match_date: { sql: "mbowl.match_date" },
    year: { sql: 'CAST(mbowl."year" AS INTEGER)' },
    month: { sql: 'CAST(mbowl."month" AS INTEGER)' },
    team_rel_econ: {
      sql:
        `CAST((mbowl.runs_conceded / NULLIF(mbowl.balls / 6.0, 0))` +
        ` - (thp.t_runs / NULLIF(thp.t_balls / 6.0, 0)) AS FLOAT)`,
      mb: ["runs_conceded", "balls"],
      thp: true,
    },
    team_rel_pbe: {
      sql: `CAST((mbowl.runs_conceded / NULLIF(mbowl.balls,0)) - (thp.t_runs / NULLIF(thp.t_balls,0)) AS FLOAT)`,
      mb: ["runs_conceded", "balls"],
      thp: true,
    },
    team_rel_dot_pct: {
      sql: `CAST((mbowl.dots / NULLIF(mbowl.balls,0) * 100.0) - (thp.t_dots / NULLIF(thp.t_balls,0) * 100.0) AS FLOAT)`,
      mb: ["dots", "balls"],
      thp: true,
    },
    team_rel_sr: {
      sql: `CAST((mbowl.balls / NULLIF(mbowl.wickets,0)) - (thp.t_balls / NULLIF(thp.t_wkts,0)) AS FLOAT)`,
      mb: ["balls", "wickets"],
      thp: true,
    },
  };
  for (const col of ["balls", "runs_conceded", "wickets", "dots", "fours_conceded", "sixes_conceded"]) {
    OUT[col] = { sql: plain(col), mb: [col] };
  }
  for (const col of Object.keys(WICKET_KIND_COLUMNS)) {
    OUT[col] = { sql: plain(col), mb: [col] };
  }
  for (const ph of PHASES) {
    for (const kind of ["balls", "runs_conceded", "wickets", "dots", "fours_conceded", "sixes_conceded"]) {
      OUT[`${ph}_${kind}`] = { sql: plain(`${ph}_${kind}`), mb: [`${ph}_${kind}`] };
      OUT[`odi_${ph}_${kind}`] = { sql: odi(`odi_${ph}_${kind}`), mb: [`odi_${ph}_${kind}`] };
    }
  }

  const emitted = viewColumnsFor("matchup_bowling").filter(has);
  const needMb = new Set();
  let needThp = false;
  for (const col of emitted) {
    const spec = OUT[col];
    if (spec.mb) for (const a of spec.mb) needMb.add(a);
    if (spec.thp) needThp = true;
  }
  const needHundred = emitted.some((c) => c.startsWith("odi_"));

  const ctes = [];
  if (needThp) {
    const tAgg = matchupBowlingTeamAggregates();
    ctes.push(
      cte(
        "thp",
        `SELECT match_id, innings_number, batting_hand, batting_position,\n                ` +
          selectFrom(tAgg, Object.keys(tAgg)).join(",\n                ") +
          `\n         FROM b GROUP BY 1,2,3,4`
      )
    );
  }
  // vs-PotMs axis (decision 81): see matchupBattingViewSql — vs_potm splits the
  // mbowl grain when emitted; thp is LEFT at the (…, batting_position) grain.
  const needPotm = has("vs_potm");
  const mbAgg = matchupBowlingAggregates();
  const mbKeys = Object.keys(mbAgg).filter((k) => needMb.has(k));
  const mbowlBody =
    `SELECT match_id, innings_number, bowler_id, batting_hand, batting_position,${needPotm ? " vs_potm," : ""}\n` +
    `                ANY_VALUE(bowler_name) bowler_name, ANY_VALUE(batting_team) batting_team,\n` +
    `                ANY_VALUE(bowling_team) bowling_team, ANY_VALUE(match_type) match_type,\n` +
    `                ANY_VALUE(gender) gender, ANY_VALUE(team_type) team_type,\n` +
    `                ANY_VALUE(match_date) match_date, ANY_VALUE(year) AS "year", ANY_VALUE(month) AS "month"` +
    (needHundred ? `,\n                MAX(CASE WHEN balls_per_over=5 THEN 1 ELSE 0 END) is_hundred` : "") +
    (mbKeys.length ? `,\n                ` + selectFrom(mbAgg, mbKeys).join(",\n                ") : "") +
    `\n         FROM b GROUP BY match_id, innings_number, bowler_id, batting_hand, batting_position${needPotm ? ", vs_potm" : ""}`;
  ctes.push(cte("mbowl", mbowlBody));

  const selectList = emitted.map((col) => `${OUT[col].sql} AS ${quoteIdent(col)}`);
  const joins = ["FROM mbowl"];
  if (needThp) {
    joins.push(
      "LEFT JOIN thp ON thp.match_id=mbowl.match_id AND thp.innings_number=mbowl.innings_number" +
        " AND thp.batting_hand=mbowl.batting_hand AND thp.batting_position=mbowl.batting_position"
    );
  }
  const finalSql = `SELECT\n    ${selectList.join(",\n    ")}\n${joins.join("\n")}`;
  return assemble("matchup_bowling", files, scopePredicate, windowPredicate, playerPredicate, ctes.join(",\n"), finalSql);
}

/**
 * Build the reconstruction SELECT for one matchup view.
 *
 * @param {"matchup_batting"|"matchup_bowling"} discipline
 * @param {object} opts
 * @param {string[]} opts.files  registered ball-file names to read (a subset is
 *   fine — db.js passes only the in-scope gender+format files).
 * @param {string} [opts.scopePredicate]  the query's core-scope ball filter,
 *   pushed into the base CTE (byte-identical; see baseWhere). EMPTY = whole file(s).
 * @param {string} [opts.windowPredicate]  Wave-3 delivery-window predicate
 *   (src/deliveryWindow.js), pushed by db.js from state.deliveryWindow. "" = no
 *   window (byte-identical); when present it restricts the base to in-window balls.
 * @param {string} [opts.playerPredicate]  db.js popup single-player base filter;
 *   EMPTY for every whole-scope query (byte-identical only for player-local cols).
 * @param {string[]|null} [opts.columns]  the matchup-grain output columns to emit
 *   (keys + context added automatically). OMIT/null for the FULL export schema.
 * @returns {string} a SELECT producing the requested columns in export order.
 */
export function buildMatchupViewSql(
  discipline,
  { files, scopePredicate = "", windowPredicate = "", playerPredicate = "", columns = null } = {}
) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("ballEngineMatchup.buildMatchupViewSql: files[] is required");
  }
  if (discipline === "matchup_batting")
    return matchupBattingViewSql(files, scopePredicate, windowPredicate, playerPredicate, columns);
  if (discipline === "matchup_bowling")
    return matchupBowlingViewSql(files, scopePredicate, windowPredicate, playerPredicate, columns);
  throw new Error(`ballEngineMatchup.buildMatchupViewSql: unknown discipline "${discipline}"`);
}
