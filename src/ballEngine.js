// src/ballEngine.js
//
// Ball-grain rebuild — Wave 2a + Wave 2s (owner decision 67). Generates the SQL
// that RECONSTRUCTS the innings-grain `batting` / `bowling` views from the six
// delivery ("ball layer") parquet files, so the browser can compute every
// Stats/Graph/popup number natively from raw balls with NO change to the query
// builders or the metric catalogue.
//
// ── Why this file exists (the architecture) ─────────────────────────────────
// Approach B (decision 67, ball-layer-design.md): keep src/metrics.js,
// src/table.js's buildQuery/buildScopeClauses BYTE-IDENTICAL. The entire swap
// lives in the view definition — behind a flag (config.js ballEngineEnabled()),
// db.js points the `batting` / `bowling` views at THIS module's output instead
// of at batting_innings.parquet / bowling_innings.parquet. Every downstream
// query is then identical by construction, because the reconstructed views are
// proven BYTE-IDENTICAL to the shipped innings exports (see verification below).
//
// ── Provenance (do not "improve" the SQL) ───────────────────────────────────
// This is a faithful port of export_parquet.py's `run_ball_layer_gates()` oracle
// (the orx_bat / orx_bowl reconstructions), which the pipeline runs on every
// build and reconciles CELL-BY-CELL against the shipped innings/matchup parquets
// (0 mismatches, 421,955 batting / 291,001 bowling rows). Two additions the
// oracle does not carry, both required to make the VIEW byte-identical to the
// EXPORT (not merely gate-passing):
//   1. `dismissal_kind` — the export has it (metrics.js's out_* dismissal-kind
//      columns read it); the oracle skips it. Reconstructed here from the flat
//      wicket_kind + the wickets_extra overflow, with a DETERMINISTIC tie-break
//      (MIN over kinds) replacing the exporter's ANY_VALUE. This is safe and
//      byte-exact: measured on the shipped data, ZERO (match,inn,player_out)
//      groups carry more than one distinct real dismissal kind (or more than one
//      distinct non-dismissal kind), so there is never a tie to break — MIN
//      returns the single kind, matching the export whatever ANY_VALUE picked.
//   2. odi_* columns are NULL for The Hundred (balls_per_over = 5), exactly as
//      sql_batting()/sql_bowling() wrap them; the oracle instead carried 0 and
//      let the reconcile compare only non-Hundred rows. The VIEW must emit NULL
//      (the export does — verified: 4,909 batting / 3,863 bowling Hundred rows).
//
// ── Numbers-sacred (CLAUDE.md Rule 1) ───────────────────────────────────────
// Every SPEC §4.1 calc rule is reproduced verbatim from the exporter fragments:
// super overs UNCONDITIONALLY excluded in the base CTE (`NOT is_super_over` — 208
// super-over balls sit inside the anchor scope; without it SA Yadav reads 1,551
// not 1,544); the ~4,450 zero-ball crease appearances recovered via the
// non_striker / player_out / wickets_extra union; dismissals via the
// wickets_extra overflow (SA Yadav = 53 → avg 29.13); bat_ball/team_ball clocks
// stored on the ball rows. Do NOT edit the calc fragments without re-proving the
// byte-identical harness AND reproducing every standing anchor.
//
// ── Wave 2s: QUERY-SHAPED reconstruction (Layer 1) ──────────────────────────
// Rebuilding all 74 batting / 71 bowling columns per search cost ~19.8 s in
// DuckDB-WASM when a search reads ~8–12 of them. `buildInningsViewSql` now takes
// a `columns` option — the innings-grain output columns to emit — and generates
// ONLY those aggregates and ONLY the CTEs they need (tinn only for
// team_inns_balls/team_rel_*; disp only for the phase-dismissal columns; wkk only
// for the wicket-type splits; sp/sp_agg only for the spell columns; os/maid/bo
// only for maidens/team_rel_econ; dis only for dismissed/dismissal_kind; posx
// only for batting_position). `columns` omitted/null = the full export schema,
// exactly as Wave 2a emitted it. db.js derives the set from the SQL it is about
// to run (src/ballColumns.js).
//
//   ROW-SET RULE (correctness-critical): pruning removes COLUMNS ONLY, never
//   rows. Innings counts are COUNT(*) over view rows, so the batting `crease`
//   CTE (the batter / non-striker / player-out / wickets_extra union that
//   recovers the ~4,450 zero-ball appearances) and the bowling `bagg` grain are
//   built IDENTICALLY whatever is pruned — every input they need stays in the
//   base projection unconditionally.
//
// ── Wave 2s: LEAN BASE PROJECTION (Layer 2) ─────────────────────────────────
// The base CTE `b` no longer does `SELECT *` over the delivery files: it
// projects exactly the ball columns the emitted CTEs reference, derived by
// token-scanning this module's OWN generated SQL against the fixed
// DELIVERY_COLUMNS vocabulary (over-inclusion is harmless; under-inclusion is
// impossible — SQL must name a column to read it, and none of the generated SQL
// uses a star expansion). This is what lets DuckDB's parquet reader skip whole
// columns — including the `wickets_extra` LIST for bowling — and is the memory
// fix for the ~3.1 GiB WASM ceiling Wave 2a hit.
//
// ── windowPredicate (Wave 3 hook) ───────────────────────────────────────────
// buildInningsViewSql takes a `windowPredicate` that is EMPTY in Wave 2a/2s. It
// is the seam Wave 3's delivery-window filter (phase / over range / ball range /
// first-or-last-X faced|bowled) will use to restrict the base ball set BEFORE
// the per-innings aggregation. Because it lands in the base WHERE (inside `b`),
// it needs no projection entry; the extras-attribution + reverse clocks it needs
// are already stored on the ball rows (decision 67). Present-but-unused here.

import { DELIVERY_COLUMNS, sqlIdentifierTokens, viewColumnsFor, alwaysColumnsFor } from "./ballColumns.js";

// ── SPEC §4.1 calc fragments (bare column names resolve to the ball table) ───
const NON_DIS = "'retired hurt', 'retired not out'"; // NON_DISMISSAL_KINDS
const FACED = "wides IS NULL"; // batter faced a ball (no-balls count as faced)
const LEGAL = "wides IS NULL AND noballs IS NULL"; // bowler legal ball
const B4 = "runs_batter = 4 AND is_not_boundary IS NOT TRUE"; // boundary four
const B6 = "runs_batter = 6 AND is_not_boundary IS NOT TRUE"; // boundary six
const BRUNS = "runs_batter + COALESCE(noballs,0) + COALESCE(wides,0)"; // bowler-charged runs

// T20-family phase of a ball: over-ranges for 6-ball matches, legal-ball ordinal
// (team_ball) for The Hundred (balls_per_over = 5). Byte-identical to the
// exporter's t20_phase_expr()/T20_PHASE_HUNDRED. NULL outside the ranges.
const T20P =
  "CASE WHEN balls_per_over=5 THEN " +
  "CASE WHEN team_ball BETWEEN 1 AND 25 THEN 'pp' " +
  "WHEN team_ball BETWEEN 26 AND 75 THEN 'mid' " +
  "WHEN team_ball >= 76 THEN 'death' END " +
  "WHEN over_number BETWEEN 0 AND 5 THEN 'pp' " +
  "WHEN over_number BETWEEN 6 AND 14 THEN 'mid' " +
  "WHEN over_number BETWEEN 15 AND 19 THEN 'death' END";
// ODI-family phase: NULL for The Hundred (odi_* columns are NULL there).
const ODIP =
  "CASE WHEN balls_per_over=5 THEN NULL " +
  "WHEN over_number BETWEEN 0 AND 9 THEN 'pp' " +
  "WHEN over_number BETWEEN 10 AND 39 THEN 'mid' " +
  "WHEN over_number BETWEEN 40 AND 49 THEN 'death' END";

const PHASES = ["pp", "mid", "death"];
// (phase expression, output-column prefix) — the two phase families every
// per-phase column family is generated over.
const PHASE_FAMILIES = [
  [T20P, ""],
  [ODIP, "odi_"],
];

/** Per-ball count of a bowler-credited wicket `kind` across the flat wicket_kind
 * column PLUS the wickets_extra overflow list (the rare ≥2-wicket ball). */
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

/** The base-CTE tail: `WHERE NOT is_super_over` plus optional predicates.
 *
 *   scopePredicate  — the query's CORE-SCOPE ball filter (gender / match_type /
 *     team_type / match_date), pushed down by db.js so DuckDB prunes row-groups
 *     and files and the per-innings aggregation runs over only in-scope balls.
 *     This is BYTE-IDENTICAL to leaving it off: those four columns are constant
 *     within a (match_id, innings_number), so filtering balls by them keeps every
 *     ball of every in-scope innings and drops only whole out-of-scope innings —
 *     which the caller's outer WHERE would discard anyway. It is the memory/speed
 *     lever (without it the reconstruction over a whole file exhausts DuckDB-WASM
 *     memory). db.js only ever passes clauses lifted verbatim from the query's own
 *     WHERE, so the base set can never be narrower than the innings the outer
 *     query keeps.
 *   windowPredicate — the Wave-3 delivery-window filter. EMPTY in Wave 2a/2s.
 *
 * Both AND into the base WHERE. With neither, exactly `WHERE NOT is_super_over`.
 * All three read the SOURCE rows, so they need no entry in the lean projection. */
function baseWhere(scopePredicate, windowPredicate) {
  let sql = "WHERE NOT is_super_over";
  const sp = (scopePredicate || "").trim();
  if (sp) sql += ` AND (${sp})`;
  const wp = (windowPredicate || "").trim();
  if (wp) sql += ` AND (${wp})`;
  return sql;
}

/**
 * Resolve the requested `columns` option into the Set of output columns to emit.
 * `null`/undefined = the full export schema (Wave 2a behaviour). The keys +
 * denormalised context columns are ALWAYS added — they are the view's identity.
 * Unknown names are ignored (db.js only ever passes vocabulary names; a typo
 * must not silently widen or narrow the schema).
 */
function wantedColumns(discipline, columns) {
  const vocab = viewColumnsFor(discipline);
  if (!columns) return new Set(vocab);
  const want = new Set(alwaysColumnsFor(discipline));
  const known = new Set(vocab);
  for (const c of columns) if (known.has(c)) want.add(c);
  return want;
}

/**
 * Stitch the base CTE onto the emitted CTEs + final SELECT, deriving the LEAN
 * base projection (Layer 2) from the generated SQL itself: every DELIVERY_COLUMNS
 * name that appears as an identifier token downstream of `b` is projected, and
 * nothing else. Token-scanning our OWN generated SQL is exact in the direction
 * that matters — a column can only be READ by naming it, and none of the SQL
 * built here uses a star expansion — so the projection can over-include (costing
 * a little I/O) but never under-include.
 */
function assemble(files, scopePredicate, windowPredicate, cteSql, finalSql) {
  const body = `${cteSql}\n${finalSql}`;
  const toks = sqlIdentifierTokens(body);
  const baseCols = DELIVERY_COLUMNS.filter((c) => toks.has(c));
  const base = `b AS (SELECT ${baseCols.join(", ")} FROM ${sourceExpr(files)} ${baseWhere(scopePredicate, windowPredicate)})`;
  return `\nWITH ${base},\n${cteSql}\n${finalSql}`;
}

/** `name AS (body)` CTE text, or null when the CTE is not needed. */
function cte(name, body) {
  return `${name} AS (${body})`;
}

/** `expr AS alias` select-list items from a {alias: expr} map, in map order,
 * restricted to `keys`. */
function selectFrom(map, keys) {
  return keys.map((k) => `${map[k]} AS ${k}`);
}

// ── Batting reconstruction ──────────────────────────────────────────────────

/** The per-(match, innings, batter) aggregates the `bat` CTE can emit, keyed by
 * the internal alias the final SELECT reads. Expressions are VERBATIM from
 * Wave 2a (SPEC §4.1) — pruning selects among them, it never rewrites them. */
function battingAggregates() {
  const m = {
    bat_name: "ANY_VALUE(batter_name)",
    runs: "SUM(runs_batter)",
    balls_faced: `SUM(CASE WHEN ${FACED} THEN 1 ELSE 0 END)`,
    dots: `SUM(CASE WHEN ${FACED} AND runs_batter=0 THEN 1 ELSE 0 END)`,
    fours_hit: `SUM(CASE WHEN ${B4} THEN 1 ELSE 0 END)`,
    sixes_hit: `SUM(CASE WHEN ${B6} THEN 1 ELSE 0 END)`,
    ones: `SUM(CASE WHEN ${FACED} AND runs_batter=1 THEN 1 ELSE 0 END)`,
    twos: `SUM(CASE WHEN ${FACED} AND runs_batter=2 THEN 1 ELSE 0 END)`,
    threes: `SUM(CASE WHEN ${FACED} AND runs_batter=3 THEN 1 ELSE 0 END)`,
    fives: `SUM(CASE WHEN ${FACED} AND runs_batter=5 THEN 1 ELSE 0 END)`,
    nb_fours: "SUM(CASE WHEN runs_batter=4 AND is_not_boundary IS TRUE THEN 1 ELSE 0 END)",
    nb_sixes: "SUM(CASE WHEN runs_batter=6 AND is_not_boundary IS TRUE THEN 1 ELSE 0 END)",
    non_boundary_runs:
      `SUM(runs_batter) - 4*SUM(CASE WHEN ${B4} THEN 1 ELSE 0 END)` +
      ` - 6*SUM(CASE WHEN ${B6} THEN 1 ELSE 0 END)`,
    fb1_10_runs: `SUM(CASE WHEN ${FACED} AND bat_ball BETWEEN 1 AND 10 THEN runs_batter ELSE 0 END)`,
    fb1_10_balls: `SUM(CASE WHEN ${FACED} AND bat_ball BETWEEN 1 AND 10 THEN 1 ELSE 0 END)`,
    fb11_20_runs: `SUM(CASE WHEN ${FACED} AND bat_ball BETWEEN 11 AND 20 THEN runs_batter ELSE 0 END)`,
    fb11_20_balls: `SUM(CASE WHEN ${FACED} AND bat_ball BETWEEN 11 AND 20 THEN 1 ELSE 0 END)`,
    fb21p_runs: `SUM(CASE WHEN ${FACED} AND bat_ball >= 21 THEN runs_batter ELSE 0 END)`,
    fb21p_balls: `SUM(CASE WHEN ${FACED} AND bat_ball >= 21 THEN 1 ELSE 0 END)`,
  };
  for (const [p, pref] of PHASE_FAMILIES) {
    for (const ph of PHASES) {
      m[`${pref}${ph}_runs`] = `SUM(CASE WHEN (${p})='${ph}' THEN runs_batter ELSE 0 END)`;
      m[`${pref}${ph}_balls`] = `SUM(CASE WHEN (${p})='${ph}' AND ${FACED} THEN 1 ELSE 0 END)`;
      m[`${pref}${ph}_dots`] = `SUM(CASE WHEN (${p})='${ph}' AND ${FACED} AND runs_batter=0 THEN 1 ELSE 0 END)`;
      m[`${pref}${ph}_fours`] = `SUM(CASE WHEN (${p})='${ph}' AND ${B4} THEN 1 ELSE 0 END)`;
      m[`${pref}${ph}_sixes`] = `SUM(CASE WHEN (${p})='${ph}' AND ${B6} THEN 1 ELSE 0 END)`;
    }
  }
  return m;
}

/** Team-innings totals (the denominators behind team_inns_balls + team_rel_*).
 * Emitted as a block: all five are SUMs over the same one GROUP BY, so pruning
 * within the block would save nothing measurable. */
function battingTeamAggregates() {
  return {
    team_inns_balls: `SUM(CASE WHEN ${FACED} THEN 1 ELSE 0 END)`,
    team_runs: `SUM(CASE WHEN ${FACED} THEN runs_batter ELSE 0 END)`,
    team_dots: `SUM(CASE WHEN ${FACED} AND runs_batter=0 THEN 1 ELSE 0 END)`,
    team_fours: `SUM(CASE WHEN ${B4} THEN 1 ELSE 0 END)`,
    team_sixes: `SUM(CASE WHEN ${B6} THEN 1 ELSE 0 END)`,
  };
}

function battingViewSql(files, scopePredicate, windowPredicate, columns) {
  const want = wantedColumns("batting", columns);
  const has = (c) => want.has(c);
  // NULL the odi_* aggregate for The Hundred, else COALESCE→0, typed DOUBLE.
  const odi = (col) => `CAST(CASE WHEN ictx.is_hundred=1 THEN NULL ELSE COALESCE(${col},0) END AS DOUBLE)`;
  const plain = (col) => `CAST(COALESCE(bat.${col},0) AS DOUBLE)`;

  // ── output-column → { sql, deps } ─────────────────────────────────────────
  // `bat` lists the internal `bat`-CTE aggregates the expression reads; the rest
  // are CTE flags. Everything is emitted in BATTING_VIEW_COLUMNS (export) order.
  const OUT = {
    match_id: { sql: "c.match_id" },
    innings_number: { sql: "CAST(c.innings_number AS INTEGER)" },
    batter_id: { sql: "c.batter_id" },
    batter_name: { sql: "COALESCE(bat.bat_name, c.any_name)", bat: ["bat_name"] },
    batting_team: { sql: "ictx.batting_team" },
    bowling_team: { sql: "ictx.bowling_team" },
    match_type: { sql: "ictx.match_type" },
    gender: { sql: "ictx.gender" },
    team_type: { sql: "ictx.team_type" },
    match_date: { sql: "ictx.match_date" },
    year: { sql: "CAST(ictx.year AS INTEGER)" },
    month: { sql: "CAST(ictx.month AS INTEGER)" },
    dismissed: { sql: "CAST(COALESCE(dis.dismissed,0) AS INTEGER)", dis: true },
    dismissal_kind: { sql: "dis.dismissal_kind", dis: true },
    batting_position: { sql: "CAST(COALESCE(posx.batting_position, c.any_pos) AS BIGINT)", posx: true },
    team_inns_balls: { sql: "CAST(COALESCE(tinn.team_inns_balls,0) AS DOUBLE)", tinn: true },
    team_rel_sr: {
      sql:
        `CAST((COALESCE(bat.runs,0) / NULLIF(COALESCE(bat.balls_faced,0),0) * 100.0)` +
        ` - (tinn.team_runs / NULLIF(tinn.team_inns_balls,0) * 100.0) AS FLOAT)`,
      bat: ["runs", "balls_faced"],
      tinn: true,
    },
    team_rel_dot_pct: {
      sql:
        `CAST((COALESCE(bat.dots,0) / NULLIF(COALESCE(bat.balls_faced,0),0) * 100.0)` +
        ` - (tinn.team_dots / NULLIF(tinn.team_inns_balls,0) * 100.0) AS FLOAT)`,
      bat: ["dots", "balls_faced"],
      tinn: true,
    },
    team_rel_bpb: {
      sql:
        `CAST((COALESCE(bat.balls_faced,0) / NULLIF(COALESCE(bat.fours_hit,0)+COALESCE(bat.sixes_hit,0),0))` +
        ` - (tinn.team_inns_balls / NULLIF(tinn.team_fours+tinn.team_sixes,0)) AS FLOAT)`,
      bat: ["balls_faced", "fours_hit", "sixes_hit"],
      tinn: true,
    },
    team_rel_nbsr: {
      sql:
        `CAST((COALESCE(bat.non_boundary_runs,0) / NULLIF(COALESCE(bat.balls_faced,0)-COALESCE(bat.fours_hit,0)-COALESCE(bat.sixes_hit,0),0) * 100.0)` +
        ` - ((tinn.team_runs-4*tinn.team_fours-6*tinn.team_sixes) / NULLIF(tinn.team_inns_balls-tinn.team_fours-tinn.team_sixes,0) * 100.0) AS FLOAT)`,
      bat: ["non_boundary_runs", "balls_faced", "fours_hit", "sixes_hit"],
      tinn: true,
    },
  };
  // Straight pass-throughs of a `bat` aggregate (COALESCE→0, DOUBLE).
  for (const col of [
    "runs",
    "balls_faced",
    "dots",
    "fours_hit",
    "sixes_hit",
    "fb1_10_runs",
    "fb1_10_balls",
    "fb11_20_runs",
    "fb11_20_balls",
    "fb21p_runs",
    "fb21p_balls",
    "ones",
    "twos",
    "threes",
    "fives",
    "nb_fours",
    "nb_sixes",
    "non_boundary_runs",
  ]) {
    OUT[col] = { sql: plain(col), bat: [col] };
  }
  // Per-phase columns: T20 family plain, ODI family NULL-for-The-Hundred.
  for (const ph of PHASES) {
    for (const kind of ["runs", "balls", "dots", "fours", "sixes"]) {
      OUT[`${ph}_${kind}`] = { sql: plain(`${ph}_${kind}`), bat: [`${ph}_${kind}`] };
      OUT[`odi_${ph}_${kind}`] = { sql: odi(`bat.odi_${ph}_${kind}`), bat: [`odi_${ph}_${kind}`] };
    }
    OUT[`${ph}_dismissals`] = { sql: `CAST(COALESCE(disp.${ph}_dismissals,0) AS DOUBLE)`, dispT20: true };
    OUT[`odi_${ph}_dismissals`] = { sql: odi(`disp.odi_${ph}_dismissals`), dispODI: true };
  }

  // ── resolve dependencies ──────────────────────────────────────────────────
  const emitted = viewColumnsFor("batting").filter(has);
  const needBat = new Set();
  let needDis = false;
  let needDispT20 = false;
  let needDispODI = false;
  let needPosx = false;
  let needTinn = false;
  for (const col of emitted) {
    const spec = OUT[col];
    if (spec.bat) for (const a of spec.bat) needBat.add(a);
    if (spec.dis) needDis = true;
    if (spec.dispT20) needDispT20 = true;
    if (spec.dispODI) needDispODI = true;
    if (spec.posx) needPosx = true;
    if (spec.tinn) needTinn = true;
  }
  // `is_hundred` exists only to NULL the odi_* family for The Hundred.
  const needHundred = emitted.some((c) => c.startsWith("odi_"));
  // `any_pos` (crease) and the position columns in `app` exist only for the
  // batting_position output. `any_name` is always needed (batter_name).
  const needPos = needPosx;

  // ── CTEs ──────────────────────────────────────────────────────────────────
  // app / crease define the ROW SET (every crease appearance, incl. the ~4,450
  // zero-ball ones). NEVER pruned in a way that changes which rows exist.
  const appCols = needPos
    ? [
        "SELECT match_id, innings_number, batter_id AS pid, batter_name AS nm, batting_position AS pos FROM b",
        "SELECT match_id, innings_number, non_striker_id, non_striker_name, non_striker_position FROM b",
        "SELECT match_id, innings_number, player_out_id, CAST(NULL AS VARCHAR), CAST(NULL AS UTINYINT)\n    FROM b WHERE player_out_id IS NOT NULL",
        "SELECT match_id, innings_number, x.player_out_id, x.player_out_name, x.batting_position\n    FROM b, UNNEST(b.wickets_extra) AS t(x)",
      ]
    : [
        "SELECT match_id, innings_number, batter_id AS pid, batter_name AS nm FROM b",
        "SELECT match_id, innings_number, non_striker_id, non_striker_name FROM b",
        "SELECT match_id, innings_number, player_out_id, CAST(NULL AS VARCHAR)\n    FROM b WHERE player_out_id IS NOT NULL",
        "SELECT match_id, innings_number, x.player_out_id, x.player_out_name\n    FROM b, UNNEST(b.wickets_extra) AS t(x)",
      ];
  const ctes = [
    cte("app", `\n    ${appCols.join("\n    UNION ALL\n    ")}\n`),
    cte(
      "crease",
      `SELECT match_id, innings_number, pid AS batter_id, MIN(nm) AS any_name` +
        `${needPos ? ",\n                  MIN(pos) AS any_pos" : ""} FROM app GROUP BY 1,2,3`
    ),
  ];
  if (needPosx) {
    ctes.push(cte("posx", "SELECT DISTINCT match_id, innings_number, batter_id, batting_position FROM b"));
  }
  ctes.push(
    cte(
      "ictx",
      `SELECT match_id, innings_number,
                ANY_VALUE(batting_team) batting_team, ANY_VALUE(bowling_team) bowling_team,
                ANY_VALUE(match_type) match_type, ANY_VALUE(gender) gender,
                ANY_VALUE(team_type) team_type, ANY_VALUE(match_date) match_date,
                ANY_VALUE(year) AS "year", ANY_VALUE(month) AS "month"${
                  needHundred ? ",\n                MAX(CASE WHEN balls_per_over=5 THEN 1 ELSE 0 END) is_hundred" : ""
                }
         FROM b GROUP BY 1,2`
    )
  );
  if (needDis) {
    ctes.push(
      cte(
        "dis",
        `SELECT match_id, innings_number, pid,
               MAX(CASE WHEN kind NOT IN (${NON_DIS}) THEN 1 ELSE 0 END) dismissed,
               COALESCE(MIN(CASE WHEN kind NOT IN (${NON_DIS}) THEN kind END), MIN(kind)) dismissal_kind
        FROM (
            SELECT match_id, innings_number, player_out_id AS pid, wicket_kind AS kind
            FROM b WHERE player_out_id IS NOT NULL
            UNION ALL
            SELECT match_id, innings_number, x.player_out_id, x.kind
            FROM b, UNNEST(b.wickets_extra) AS t(x)
        ) GROUP BY 1,2,3`
      )
    );
  }
  if (needDispT20 || needDispODI) {
    const blocks = [];
    if (needDispT20) blocks.push(phaseDismissalBlock(T20P, ""));
    if (needDispODI) blocks.push(phaseDismissalBlock(ODIP, "odi_"));
    ctes.push(
      cte(
        "disp",
        `SELECT match_id, innings_number, pid,
                ${blocks.join(",\n                ")}
         FROM (
            SELECT match_id, innings_number, player_out_id AS pid, over_number, team_ball, balls_per_over
            FROM b WHERE player_out_id IS NOT NULL AND wicket_kind NOT IN (${NON_DIS})
            UNION ALL
            SELECT b.match_id, b.innings_number, x.player_out_id, b.over_number, b.team_ball, b.balls_per_over
            FROM b, UNNEST(b.wickets_extra) AS t(x) WHERE x.kind NOT IN (${NON_DIS})
         ) GROUP BY 1,2,3`
      )
    );
  }
  const batAgg = battingAggregates();
  const batKeys = Object.keys(batAgg).filter((k) => needBat.has(k));
  const needBatCte = batKeys.length > 0;
  if (needBatCte) {
    ctes.push(
      cte(
        "bat",
        `SELECT match_id, innings_number, batter_id,\n               ` +
          selectFrom(batAgg, batKeys).join(",\n               ") +
          `\n        FROM b WHERE batter_id IS NOT NULL GROUP BY 1,2,3`
      )
    );
  }
  if (needTinn) {
    const tAgg = battingTeamAggregates();
    ctes.push(
      cte(
        "tinn",
        `SELECT match_id, innings_number,\n                ` +
          selectFrom(tAgg, Object.keys(tAgg)).join(",\n                ") +
          `\n         FROM b GROUP BY 1,2`
      )
    );
  }

  // ── final SELECT ──────────────────────────────────────────────────────────
  const selectList = emitted.map((col) => `${OUT[col].sql} AS ${quoteIdent(col)}`);
  const joins = ["FROM crease c", "LEFT JOIN ictx ON ictx.match_id=c.match_id AND ictx.innings_number=c.innings_number"];
  if (needBatCte) {
    joins.push("LEFT JOIN bat  ON bat.match_id=c.match_id AND bat.innings_number=c.innings_number AND bat.batter_id=c.batter_id");
  }
  if (needDis) {
    joins.push("LEFT JOIN dis  ON dis.match_id=c.match_id AND dis.innings_number=c.innings_number AND dis.pid=c.batter_id");
  }
  if (needDispT20 || needDispODI) {
    joins.push("LEFT JOIN disp ON disp.match_id=c.match_id AND disp.innings_number=c.innings_number AND disp.pid=c.batter_id");
  }
  if (needPosx) {
    joins.push("LEFT JOIN posx ON posx.match_id=c.match_id AND posx.innings_number=c.innings_number AND posx.batter_id=c.batter_id");
  }
  if (needTinn) {
    joins.push("LEFT JOIN tinn ON tinn.match_id=c.match_id AND tinn.innings_number=c.innings_number");
  }
  const finalSql = `SELECT\n    ${selectList.join(",\n    ")}\n${joins.join("\n")}`;
  return assemble(files, scopePredicate, windowPredicate, ctes.join(",\n"), finalSql);
}

/** Batting phase-dismissal block (all-kinds count, phase-bucketed). */
function phaseDismissalBlock(p, pref) {
  return PHASES.map((ph) => `SUM(CASE WHEN (${p})='${ph}' THEN 1 ELSE 0 END) AS ${pref}${ph}_dismissals`).join(
    ",\n                "
  );
}

/** `year` / `month` are SQL keywords in DuckDB's parser — the export schema
 * quotes them, so the reconstruction must too. */
function quoteIdent(name) {
  return name === "year" || name === "month" ? `"${name}"` : name;
}

// ── Bowling reconstruction ──────────────────────────────────────────────────

/** The per-(match, innings, bowler) aggregates the `bagg` CTE can emit. The
 * ANY_VALUE context block is always present (it carries the view's context
 * columns); the rest are pruned to what the query reads. */
function bowlingAggregates() {
  const m = {
    balls: `SUM(CASE WHEN ${LEGAL} THEN 1 ELSE 0 END)`,
    runs_conceded: `SUM(${BRUNS})`,
    wickets: "SUM(bowler_credited_wkts)",
    dots: `SUM(CASE WHEN ${LEGAL} AND runs_batter=0 THEN 1 ELSE 0 END)`,
    fours_conceded: `SUM(CASE WHEN ${B4} THEN 1 ELSE 0 END)`,
    sixes_conceded: `SUM(CASE WHEN ${B6} THEN 1 ELSE 0 END)`,
    wides_runs: "SUM(COALESCE(wides,0))",
    noball_runs: "SUM(COALESCE(noballs,0))",
  };
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

const WICKET_KIND_COLUMNS = {
  wickets_bowled: "bowled",
  wickets_lbw: "lbw",
  wickets_caught: "caught",
  wickets_caught_and_bowled: "caught and bowled",
  wickets_stumped: "stumped",
  wickets_hit_wicket: "hit wicket",
};

function bowlingViewSql(files, scopePredicate, windowPredicate, columns) {
  const want = wantedColumns("bowling", columns);
  const has = (c) => want.has(c);
  const odi = (col) => `CAST(CASE WHEN bagg.is_hundred=1 THEN NULL ELSE ${col} END AS DOUBLE)`;

  const OUT = {
    match_id: { sql: "bagg.match_id" },
    innings_number: { sql: "CAST(bagg.innings_number AS INTEGER)" },
    bowler_id: { sql: "bagg.bowler_id" },
    bowler_name: { sql: "bagg.bowler_name" },
    bowling_team: { sql: "bagg.bowling_team" },
    batting_team: { sql: "bagg.batting_team" },
    match_type: { sql: "bagg.match_type" },
    gender: { sql: "bagg.gender" },
    team_type: { sql: "bagg.team_type" },
    match_date: { sql: "bagg.match_date" },
    year: { sql: "CAST(bagg.year AS INTEGER)" },
    month: { sql: "CAST(bagg.month AS INTEGER)" },
    maidens: { sql: "CAST(COALESCE(maid.maidens,0) AS DOUBLE)", maid: true },
    team_rel_econ: {
      sql:
        `CAST((bagg.runs_conceded / NULLIF(CAST(CAST(bo.complete_overs AS VARCHAR) || '.' || CAST(bo.incomplete_balls AS VARCHAR) AS DOUBLE),0))` +
        ` - (tb.t_runs / NULLIF(tb.t_balls / 6.0, 0)) AS FLOAT)`,
      bagg: ["runs_conceded"],
      bo: true,
      tb: true,
    },
    team_rel_pbe: {
      sql: `CAST((bagg.runs_conceded / NULLIF(bagg.balls,0)) - (tb.t_runs / NULLIF(tb.t_balls,0)) AS FLOAT)`,
      bagg: ["runs_conceded", "balls"],
      tb: true,
    },
    team_rel_dot_pct: {
      sql: `CAST((bagg.dots / NULLIF(bagg.balls,0) * 100.0) - (tb.t_dots / NULLIF(tb.t_balls,0) * 100.0) AS FLOAT)`,
      bagg: ["dots", "balls"],
      tb: true,
    },
    team_rel_sr: {
      sql: `CAST((bagg.balls / NULLIF(bagg.wickets,0)) - (tb.t_balls / NULLIF(tw.t_wkts,0)) AS FLOAT)`,
      bagg: ["balls", "wickets"],
      tb: true,
      tw: true,
    },
    spell_count: { sql: "CAST(COALESCE(sp.spell_count,0) AS DOUBLE)", sp: true },
    longest_spell_balls: { sql: "CAST(COALESCE(sp.longest_spell_balls,0) AS DOUBLE)", sp: true },
    best_spell_wkts: { sql: "CAST(COALESCE(sp.best_spell_wkts,0) AS BIGINT)", sp: true },
    best_spell_runs: { sql: "CAST(COALESCE(sp.best_spell_runs,0) AS DOUBLE)", sp: true },
  };
  for (const col of ["balls", "runs_conceded", "wickets", "dots", "fours_conceded", "sixes_conceded", "wides_runs", "noball_runs"]) {
    OUT[col] = { sql: `CAST(bagg.${col} AS DOUBLE)`, bagg: [col] };
  }
  for (const col of Object.keys(WICKET_KIND_COLUMNS)) {
    OUT[col] = { sql: `CAST(wkk.${col} AS DOUBLE)`, wkk: [col] };
  }
  for (const ph of PHASES) {
    for (const kind of ["balls", "runs_conceded", "wickets", "dots", "fours_conceded", "sixes_conceded"]) {
      OUT[`${ph}_${kind}`] = { sql: `CAST(bagg.${ph}_${kind} AS DOUBLE)`, bagg: [`${ph}_${kind}`] };
      OUT[`odi_${ph}_${kind}`] = { sql: odi(`bagg.odi_${ph}_${kind}`), bagg: [`odi_${ph}_${kind}`] };
    }
  }

  const emitted = viewColumnsFor("bowling").filter(has);
  const needBagg = new Set();
  const needWkk = new Set();
  let needMaid = false;
  let needBo = false;
  let needTb = false;
  let needTw = false;
  let needSp = false;
  for (const col of emitted) {
    const spec = OUT[col];
    if (spec.bagg) for (const a of spec.bagg) needBagg.add(a);
    if (spec.wkk) for (const a of spec.wkk) needWkk.add(a);
    if (spec.maid) needMaid = true;
    if (spec.bo) needBo = true;
    if (spec.tb) needTb = true;
    if (spec.tw) needTw = true;
    if (spec.sp) needSp = true;
  }
  const needHundred = emitted.some((c) => c.startsWith("odi_"));
  const needOs = needMaid || needBo;

  const ctes = [];
  if (needOs) {
    ctes.push(
      cte(
        "os",
        `SELECT match_id, innings_number, over_number, bowler_id,
              ANY_VALUE(balls_per_over) bpo,
              SUM(CASE WHEN ${LEGAL} THEN 1 ELSE 0 END) legal_balls,
              SUM(${BRUNS}) conceded
       FROM b WHERE bowler_id IS NOT NULL GROUP BY 1,2,3,4`
      )
    );
  }
  if (needMaid) {
    ctes.push(
      cte(
        "maid",
        `SELECT match_id, innings_number, bowler_id,
                SUM(CASE WHEN legal_balls=bpo AND conceded=0 THEN 1 ELSE 0 END) maidens
         FROM os GROUP BY 1,2,3`
      )
    );
  }
  if (needBo) {
    ctes.push(
      cte(
        "bo",
        `SELECT match_id, innings_number, bowler_id,
              SUM(CASE WHEN legal_balls=6 THEN 1 ELSE 0 END) complete_overs,
              SUM(CASE WHEN legal_balls<6 THEN legal_balls ELSE 0 END) incomplete_balls
       FROM os GROUP BY 1,2,3`
      )
    );
  }
  if (needTb) {
    ctes.push(
      cte(
        "tb",
        `SELECT match_id, innings_number,
              SUM(CASE WHEN ${LEGAL} THEN 1 ELSE 0 END) t_balls,
              SUM(${BRUNS}) t_runs,
              SUM(CASE WHEN ${LEGAL} AND runs_batter=0 THEN 1 ELSE 0 END) t_dots
       FROM b GROUP BY 1,2`
      )
    );
  }
  if (needTw) {
    ctes.push(
      cte("tw", `SELECT match_id, innings_number, SUM(bowler_credited_wkts) t_wkts\n       FROM b WHERE bowler_id IS NOT NULL GROUP BY 1,2`)
    );
  }
  if (needSp) {
    ctes.push(
      cte(
        "sp_agg",
        `SELECT match_id, innings_number, bowler_id, spell_number,
                  SUM(CASE WHEN ${LEGAL} THEN 1 ELSE 0 END) s_balls,
                  SUM(${BRUNS}) s_runs,
                  SUM(bowler_credited_wkts) s_wkts
           FROM b WHERE bowler_id IS NOT NULL GROUP BY 1,2,3,4`
      )
    );
    ctes.push(
      cte(
        "sp",
        `SELECT match_id, innings_number, bowler_id,
              MAX(spell_number) spell_count, MAX(s_balls) longest_spell_balls,
              arg_max(s_wkts, s_wkts*1000 - s_runs) best_spell_wkts,
              arg_max(s_runs, s_wkts*1000 - s_runs) best_spell_runs
       FROM sp_agg GROUP BY 1,2,3`
      )
    );
  }
  if (needWkk.size) {
    const kinds = Object.keys(WICKET_KIND_COLUMNS).filter((k) => needWkk.has(k));
    ctes.push(
      cte(
        "wkk",
        `SELECT match_id, innings_number, bowler_id,\n               ` +
          kinds.map((k) => `SUM(${kindct(WICKET_KIND_COLUMNS[k])}) ${k}`).join(",\n               ") +
          `\n        FROM b WHERE bowler_id IS NOT NULL GROUP BY 1,2,3`
      )
    );
  }
  // `bagg` is the ROW SET (one row per match/innings/bowler with any ball) and
  // carries the context columns — always emitted, never pruned below its
  // ANY_VALUE context block.
  const baggAgg = bowlingAggregates();
  const baggKeys = Object.keys(baggAgg).filter((k) => needBagg.has(k));
  const baggTail = [
    ...(needHundred ? ["MAX(CASE WHEN balls_per_over=5 THEN 1 ELSE 0 END) is_hundred"] : []),
    ...selectFrom(baggAgg, baggKeys),
  ];
  ctes.push(
    cte(
      "bagg",
      `SELECT match_id, innings_number, bowler_id,
                ANY_VALUE(bowler_name) bowler_name, ANY_VALUE(batting_team) batting_team,
                ANY_VALUE(bowling_team) bowling_team, ANY_VALUE(match_type) match_type,
                ANY_VALUE(gender) gender, ANY_VALUE(team_type) team_type,
                ANY_VALUE(match_date) match_date, ANY_VALUE(year) AS "year", ANY_VALUE(month) AS "month"${
                  baggTail.length ? ",\n                " + baggTail.join(",\n                ") : ""
                }
         FROM b WHERE bowler_id IS NOT NULL GROUP BY 1,2,3`
    )
  );

  const selectList = emitted.map((col) => `${OUT[col].sql} AS ${quoteIdent(col)}`);
  const joins = ["FROM bagg"];
  if (needMaid) {
    joins.push("LEFT JOIN maid ON maid.match_id=bagg.match_id AND maid.innings_number=bagg.innings_number AND maid.bowler_id=bagg.bowler_id");
  }
  if (needBo) {
    joins.push("LEFT JOIN bo   ON bo.match_id=bagg.match_id AND bo.innings_number=bagg.innings_number AND bo.bowler_id=bagg.bowler_id");
  }
  if (needWkk.size) {
    joins.push("LEFT JOIN wkk  ON wkk.match_id=bagg.match_id AND wkk.innings_number=bagg.innings_number AND wkk.bowler_id=bagg.bowler_id");
  }
  if (needSp) {
    joins.push("LEFT JOIN sp   ON sp.match_id=bagg.match_id AND sp.innings_number=bagg.innings_number AND sp.bowler_id=bagg.bowler_id");
  }
  if (needTb) {
    joins.push("LEFT JOIN tb   ON tb.match_id=bagg.match_id AND tb.innings_number=bagg.innings_number");
  }
  if (needTw) {
    joins.push("LEFT JOIN tw   ON tw.match_id=bagg.match_id AND tw.innings_number=bagg.innings_number");
  }
  const finalSql = `SELECT ${selectList.join(",\n    ")}\n${joins.join("\n")}`;
  return assemble(files, scopePredicate, windowPredicate, ctes.join(",\n"), finalSql);
}

/**
 * Build the reconstruction SELECT for one discipline's innings view.
 *
 * @param {"batting"|"bowling"} discipline
 * @param {object} opts
 * @param {string[]} opts.files  registered ball-file names to read (a subset is
 *   fine — each file is single-gender/single-format, so db.js may pass only the
 *   in-scope files; reading all six is also correct, just heavier).
 * @param {string} [opts.scopePredicate]  the query's core-scope ball filter
 *   (gender / match_type / team_type / match_date), pushed into the base CTE for
 *   row-group/file pruning + a smaller aggregation. BYTE-IDENTICAL (see
 *   baseWhere). db.js derives it from the query's own WHERE; EMPTY = reconstruct
 *   the whole file(s).
 * @param {string} [opts.windowPredicate]  Wave-3 delivery-window predicate over
 *   the raw ball columns; EMPTY in Wave 2a/2s (present-but-unused hook).
 * @param {string[]|null} [opts.columns]  Wave 2s Layer 1: the innings-grain
 *   output columns to emit (keys + context are added automatically). Only the
 *   aggregates and CTEs those columns need are generated. OMIT or pass null for
 *   the FULL export schema — exactly the columns (names, order, types) of
 *   batting_innings.parquet / bowling_innings.parquet.
 * @returns {string} a SELECT producing the requested columns in export order.
 */
export function buildInningsViewSql(
  discipline,
  { files, scopePredicate = "", windowPredicate = "", columns = null } = {}
) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("ballEngine.buildInningsViewSql: files[] is required");
  }
  if (discipline === "batting") return battingViewSql(files, scopePredicate, windowPredicate, columns);
  if (discipline === "bowling") return bowlingViewSql(files, scopePredicate, windowPredicate, columns);
  throw new Error(`ballEngine.buildInningsViewSql: unknown discipline "${discipline}"`);
}

/** The six ball-file names (gender × format bucket), matching config.js /
 * export_parquet.py DELIVERY_FILES. Exported so db.js registers + reads them. */
export const DELIVERY_FILES = [
  "deliveries_m_t20.parquet",
  "deliveries_m_odi.parquet",
  "deliveries_m_red.parquet",
  "deliveries_f_t20.parquet",
  "deliveries_f_odi.parquet",
  "deliveries_f_red.parquet",
];
