// src/ballEngine.js
//
// Ball-grain rebuild — Wave 2a (owner decision 67). Generates the SQL that
// RECONSTRUCTS the innings-grain `batting` / `bowling` views from the six
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
// ── windowPredicate (Wave 3 hook) ───────────────────────────────────────────
// buildInningsViewSql takes a `windowPredicate` that is EMPTY in Wave 2a. It is
// the seam Wave 3's delivery-window filter (phase / over range / ball range /
// first-or-last-X faced|bowled) will use to restrict the base ball set BEFORE
// the per-innings aggregation. The extras-attribution + reverse clocks it needs
// are already stored on the ball rows (decision 67). Present-but-unused here.

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

/** Per-ball count of a bowler-credited wicket `kind` across the flat wicket_kind
 * column PLUS the wickets_extra overflow list (the rare ≥2-wicket ball). */
function kindct(kind) {
  const k = kind.replace(/'/g, "''");
  return (
    `((CASE WHEN wicket_kind = '${k}' THEN 1 ELSE 0 END)` +
    ` + COALESCE(len(list_filter(wickets_extra, x -> x.kind = '${k}')), 0))`
  );
}

/** Batting phase block (runs/balls/dots/fours/sixes) for one phase family. */
function batPhaseCols(p, pref) {
  return ["pp", "mid", "death"]
    .map(
      (ph) =>
        `SUM(CASE WHEN (${p})='${ph}' THEN runs_batter ELSE 0 END) AS ${pref}${ph}_runs,\n` +
        `SUM(CASE WHEN (${p})='${ph}' AND ${FACED} THEN 1 ELSE 0 END) AS ${pref}${ph}_balls,\n` +
        `SUM(CASE WHEN (${p})='${ph}' AND ${FACED} AND runs_batter=0 THEN 1 ELSE 0 END) AS ${pref}${ph}_dots,\n` +
        `SUM(CASE WHEN (${p})='${ph}' AND ${B4} THEN 1 ELSE 0 END) AS ${pref}${ph}_fours,\n` +
        `SUM(CASE WHEN (${p})='${ph}' AND ${B6} THEN 1 ELSE 0 END) AS ${pref}${ph}_sixes`
    )
    .join(",\n");
}

/** Batting phase-dismissal block (all-kinds count, phase-bucketed). */
function batPhaseDis(p, pref) {
  return ["pp", "mid", "death"]
    .map((ph) => `SUM(CASE WHEN (${p})='${ph}' THEN 1 ELSE 0 END) AS ${pref}${ph}_dismissals`)
    .join(",\n");
}

/** Bowling phase block (balls/runs_conceded/wickets/dots/fours/sixes conceded). */
function bowlPhaseCols(p, pref) {
  return ["pp", "mid", "death"]
    .map(
      (ph) =>
        `SUM(CASE WHEN (${p})='${ph}' AND ${LEGAL} THEN 1 ELSE 0 END) AS ${pref}${ph}_balls,\n` +
        `SUM(CASE WHEN (${p})='${ph}' THEN ${BRUNS} ELSE 0 END) AS ${pref}${ph}_runs_conceded,\n` +
        `SUM(CASE WHEN (${p})='${ph}' THEN bowler_credited_wkts ELSE 0 END) AS ${pref}${ph}_wickets,\n` +
        `SUM(CASE WHEN (${p})='${ph}' AND ${LEGAL} AND runs_batter=0 THEN 1 ELSE 0 END) AS ${pref}${ph}_dots,\n` +
        `SUM(CASE WHEN (${p})='${ph}' AND ${B4} THEN 1 ELSE 0 END) AS ${pref}${ph}_fours_conceded,\n` +
        `SUM(CASE WHEN (${p})='${ph}' AND ${B6} THEN 1 ELSE 0 END) AS ${pref}${ph}_sixes_conceded`
    )
    .join(",\n");
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
 *   windowPredicate — the Wave-3 delivery-window filter. EMPTY in Wave 2a.
 *
 * Both AND into the base WHERE. With neither, exactly `WHERE NOT is_super_over`. */
function baseWhere(scopePredicate, windowPredicate) {
  let sql = "WHERE NOT is_super_over";
  const sp = (scopePredicate || "").trim();
  if (sp) sql += ` AND (${sp})`;
  const wp = (windowPredicate || "").trim();
  if (wp) sql += ` AND (${wp})`;
  return sql;
}

// ── Batting reconstruction ──────────────────────────────────────────────────
function battingViewSql(files, scopePredicate, windowPredicate) {
  const src = sourceExpr(files);
  // NULL the odi_* aggregate for The Hundred, else COALESCE→0, typed DOUBLE.
  const odi = (col) => `CAST(CASE WHEN ictx.is_hundred=1 THEN NULL ELSE COALESCE(${col},0) END AS DOUBLE)`;
  return `
WITH b AS (SELECT * FROM ${src} ${baseWhere(scopePredicate, windowPredicate)}),
app AS (
    SELECT match_id, innings_number, batter_id AS pid, batter_name AS nm, batting_position AS pos FROM b
    UNION ALL
    SELECT match_id, innings_number, non_striker_id, non_striker_name, non_striker_position FROM b
    UNION ALL
    SELECT match_id, innings_number, player_out_id, CAST(NULL AS VARCHAR), CAST(NULL AS UTINYINT)
    FROM b WHERE player_out_id IS NOT NULL
    UNION ALL
    SELECT match_id, innings_number, x.player_out_id, x.player_out_name, x.batting_position
    FROM b, UNNEST(b.wickets_extra) AS t(x)
),
crease AS (SELECT match_id, innings_number, pid AS batter_id, MIN(nm) AS any_name,
                  MIN(pos) AS any_pos FROM app GROUP BY 1,2,3),
posx AS (SELECT DISTINCT match_id, innings_number, batter_id, batting_position FROM b),
ictx AS (SELECT match_id, innings_number,
                ANY_VALUE(batting_team) batting_team, ANY_VALUE(bowling_team) bowling_team,
                ANY_VALUE(match_type) match_type, ANY_VALUE(gender) gender,
                ANY_VALUE(team_type) team_type, ANY_VALUE(match_date) match_date,
                ANY_VALUE(year) AS "year", ANY_VALUE(month) AS "month",
                MAX(CASE WHEN balls_per_over=5 THEN 1 ELSE 0 END) is_hundred
         FROM b GROUP BY 1,2),
dis AS (SELECT match_id, innings_number, pid,
               MAX(CASE WHEN kind NOT IN (${NON_DIS}) THEN 1 ELSE 0 END) dismissed,
               COALESCE(MIN(CASE WHEN kind NOT IN (${NON_DIS}) THEN kind END), MIN(kind)) dismissal_kind
        FROM (
            SELECT match_id, innings_number, player_out_id AS pid, wicket_kind AS kind
            FROM b WHERE player_out_id IS NOT NULL
            UNION ALL
            SELECT match_id, innings_number, x.player_out_id, x.kind
            FROM b, UNNEST(b.wickets_extra) AS t(x)
        ) GROUP BY 1,2,3),
disp AS (SELECT match_id, innings_number, pid,
                ${batPhaseDis(T20P, "")},
                ${batPhaseDis(ODIP, "odi_")}
         FROM (
            SELECT match_id, innings_number, player_out_id AS pid, over_number, team_ball, balls_per_over
            FROM b WHERE player_out_id IS NOT NULL AND wicket_kind NOT IN (${NON_DIS})
            UNION ALL
            SELECT b.match_id, b.innings_number, x.player_out_id, b.over_number, b.team_ball, b.balls_per_over
            FROM b, UNNEST(b.wickets_extra) AS t(x) WHERE x.kind NOT IN (${NON_DIS})
         ) GROUP BY 1,2,3),
bat AS (SELECT match_id, innings_number, batter_id,
               ANY_VALUE(batter_name) bat_name,
               SUM(runs_batter) runs,
               SUM(CASE WHEN ${FACED} THEN 1 ELSE 0 END) balls_faced,
               SUM(CASE WHEN ${FACED} AND runs_batter=0 THEN 1 ELSE 0 END) dots,
               SUM(CASE WHEN ${B4} THEN 1 ELSE 0 END) fours_hit,
               SUM(CASE WHEN ${B6} THEN 1 ELSE 0 END) sixes_hit,
               SUM(CASE WHEN ${FACED} AND runs_batter=1 THEN 1 ELSE 0 END) ones,
               SUM(CASE WHEN ${FACED} AND runs_batter=2 THEN 1 ELSE 0 END) twos,
               SUM(CASE WHEN ${FACED} AND runs_batter=3 THEN 1 ELSE 0 END) threes,
               SUM(CASE WHEN ${FACED} AND runs_batter=5 THEN 1 ELSE 0 END) fives,
               SUM(CASE WHEN runs_batter=4 AND is_not_boundary IS TRUE THEN 1 ELSE 0 END) nb_fours,
               SUM(CASE WHEN runs_batter=6 AND is_not_boundary IS TRUE THEN 1 ELSE 0 END) nb_sixes,
               SUM(runs_batter) - 4*SUM(CASE WHEN ${B4} THEN 1 ELSE 0 END)
                                - 6*SUM(CASE WHEN ${B6} THEN 1 ELSE 0 END) non_boundary_runs,
               SUM(CASE WHEN ${FACED} AND bat_ball BETWEEN 1 AND 10 THEN runs_batter ELSE 0 END) fb1_10_runs,
               SUM(CASE WHEN ${FACED} AND bat_ball BETWEEN 1 AND 10 THEN 1 ELSE 0 END) fb1_10_balls,
               SUM(CASE WHEN ${FACED} AND bat_ball BETWEEN 11 AND 20 THEN runs_batter ELSE 0 END) fb11_20_runs,
               SUM(CASE WHEN ${FACED} AND bat_ball BETWEEN 11 AND 20 THEN 1 ELSE 0 END) fb11_20_balls,
               SUM(CASE WHEN ${FACED} AND bat_ball >= 21 THEN runs_batter ELSE 0 END) fb21p_runs,
               SUM(CASE WHEN ${FACED} AND bat_ball >= 21 THEN 1 ELSE 0 END) fb21p_balls,
               ${batPhaseCols(T20P, "")},
               ${batPhaseCols(ODIP, "odi_")}
        FROM b WHERE batter_id IS NOT NULL GROUP BY 1,2,3),
tinn AS (SELECT match_id, innings_number,
                SUM(CASE WHEN ${FACED} THEN 1 ELSE 0 END) team_inns_balls,
                SUM(CASE WHEN ${FACED} THEN runs_batter ELSE 0 END) team_runs,
                SUM(CASE WHEN ${FACED} AND runs_batter=0 THEN 1 ELSE 0 END) team_dots,
                SUM(CASE WHEN ${B4} THEN 1 ELSE 0 END) team_fours,
                SUM(CASE WHEN ${B6} THEN 1 ELSE 0 END) team_sixes
         FROM b GROUP BY 1,2)
SELECT
    c.match_id, CAST(c.innings_number AS INTEGER) AS innings_number, c.batter_id,
    COALESCE(bat.bat_name, c.any_name) AS batter_name,
    ictx.batting_team, ictx.bowling_team, ictx.match_type, ictx.gender, ictx.team_type,
    ictx.match_date, CAST(ictx.year AS INTEGER) AS "year", CAST(ictx.month AS INTEGER) AS "month",
    CAST(COALESCE(bat.runs,0) AS DOUBLE) runs, CAST(COALESCE(bat.balls_faced,0) AS DOUBLE) balls_faced,
    CAST(COALESCE(bat.dots,0) AS DOUBLE) dots, CAST(COALESCE(bat.fours_hit,0) AS DOUBLE) fours_hit,
    CAST(COALESCE(bat.sixes_hit,0) AS DOUBLE) sixes_hit, CAST(COALESCE(dis.dismissed,0) AS INTEGER) dismissed,
    dis.dismissal_kind, CAST(COALESCE(posx.batting_position, c.any_pos) AS BIGINT) batting_position,
    CAST(COALESCE(bat.pp_runs,0) AS DOUBLE) pp_runs, CAST(COALESCE(bat.pp_balls,0) AS DOUBLE) pp_balls,
    CAST(COALESCE(bat.mid_runs,0) AS DOUBLE) mid_runs, CAST(COALESCE(bat.mid_balls,0) AS DOUBLE) mid_balls,
    CAST(COALESCE(bat.death_runs,0) AS DOUBLE) death_runs, CAST(COALESCE(bat.death_balls,0) AS DOUBLE) death_balls,
    ${odi("bat.odi_pp_runs")} odi_pp_runs, ${odi("bat.odi_pp_balls")} odi_pp_balls,
    ${odi("bat.odi_mid_runs")} odi_mid_runs, ${odi("bat.odi_mid_balls")} odi_mid_balls,
    ${odi("bat.odi_death_runs")} odi_death_runs, ${odi("bat.odi_death_balls")} odi_death_balls,
    CAST(COALESCE(bat.fb1_10_runs,0) AS DOUBLE) fb1_10_runs, CAST(COALESCE(bat.fb1_10_balls,0) AS DOUBLE) fb1_10_balls,
    CAST(COALESCE(bat.fb11_20_runs,0) AS DOUBLE) fb11_20_runs, CAST(COALESCE(bat.fb11_20_balls,0) AS DOUBLE) fb11_20_balls,
    CAST(COALESCE(bat.fb21p_runs,0) AS DOUBLE) fb21p_runs, CAST(COALESCE(bat.fb21p_balls,0) AS DOUBLE) fb21p_balls,
    CAST(COALESCE(bat.pp_dots,0) AS DOUBLE) pp_dots, CAST(COALESCE(bat.pp_fours,0) AS DOUBLE) pp_fours, CAST(COALESCE(bat.pp_sixes,0) AS DOUBLE) pp_sixes,
    CAST(COALESCE(disp.pp_dismissals,0) AS DOUBLE) pp_dismissals,
    CAST(COALESCE(bat.mid_dots,0) AS DOUBLE) mid_dots, CAST(COALESCE(bat.mid_fours,0) AS DOUBLE) mid_fours, CAST(COALESCE(bat.mid_sixes,0) AS DOUBLE) mid_sixes,
    CAST(COALESCE(disp.mid_dismissals,0) AS DOUBLE) mid_dismissals,
    CAST(COALESCE(bat.death_dots,0) AS DOUBLE) death_dots, CAST(COALESCE(bat.death_fours,0) AS DOUBLE) death_fours, CAST(COALESCE(bat.death_sixes,0) AS DOUBLE) death_sixes,
    CAST(COALESCE(disp.death_dismissals,0) AS DOUBLE) death_dismissals,
    ${odi("bat.odi_pp_dots")} odi_pp_dots, ${odi("bat.odi_pp_fours")} odi_pp_fours, ${odi("bat.odi_pp_sixes")} odi_pp_sixes,
    ${odi("disp.odi_pp_dismissals")} odi_pp_dismissals,
    ${odi("bat.odi_mid_dots")} odi_mid_dots, ${odi("bat.odi_mid_fours")} odi_mid_fours, ${odi("bat.odi_mid_sixes")} odi_mid_sixes,
    ${odi("disp.odi_mid_dismissals")} odi_mid_dismissals,
    ${odi("bat.odi_death_dots")} odi_death_dots, ${odi("bat.odi_death_fours")} odi_death_fours, ${odi("bat.odi_death_sixes")} odi_death_sixes,
    ${odi("disp.odi_death_dismissals")} odi_death_dismissals,
    CAST(COALESCE(bat.ones,0) AS DOUBLE) ones, CAST(COALESCE(bat.twos,0) AS DOUBLE) twos, CAST(COALESCE(bat.threes,0) AS DOUBLE) threes, CAST(COALESCE(bat.fives,0) AS DOUBLE) fives,
    CAST(COALESCE(bat.nb_fours,0) AS DOUBLE) nb_fours, CAST(COALESCE(bat.nb_sixes,0) AS DOUBLE) nb_sixes, CAST(COALESCE(bat.non_boundary_runs,0) AS DOUBLE) non_boundary_runs,
    CAST(COALESCE(tinn.team_inns_balls,0) AS DOUBLE) team_inns_balls,
    CAST((COALESCE(bat.runs,0) / NULLIF(COALESCE(bat.balls_faced,0),0) * 100.0)
         - (tinn.team_runs / NULLIF(tinn.team_inns_balls,0) * 100.0) AS FLOAT) team_rel_sr,
    CAST((COALESCE(bat.dots,0) / NULLIF(COALESCE(bat.balls_faced,0),0) * 100.0)
         - (tinn.team_dots / NULLIF(tinn.team_inns_balls,0) * 100.0) AS FLOAT) team_rel_dot_pct,
    CAST((COALESCE(bat.balls_faced,0) / NULLIF(COALESCE(bat.fours_hit,0)+COALESCE(bat.sixes_hit,0),0))
         - (tinn.team_inns_balls / NULLIF(tinn.team_fours+tinn.team_sixes,0)) AS FLOAT) team_rel_bpb,
    CAST((COALESCE(bat.non_boundary_runs,0) / NULLIF(COALESCE(bat.balls_faced,0)-COALESCE(bat.fours_hit,0)-COALESCE(bat.sixes_hit,0),0) * 100.0)
         - ((tinn.team_runs-4*tinn.team_fours-6*tinn.team_sixes) / NULLIF(tinn.team_inns_balls-tinn.team_fours-tinn.team_sixes,0) * 100.0) AS FLOAT) team_rel_nbsr
FROM crease c
LEFT JOIN ictx ON ictx.match_id=c.match_id AND ictx.innings_number=c.innings_number
LEFT JOIN bat  ON bat.match_id=c.match_id AND bat.innings_number=c.innings_number AND bat.batter_id=c.batter_id
LEFT JOIN dis  ON dis.match_id=c.match_id AND dis.innings_number=c.innings_number AND dis.pid=c.batter_id
LEFT JOIN disp ON disp.match_id=c.match_id AND disp.innings_number=c.innings_number AND disp.pid=c.batter_id
LEFT JOIN posx ON posx.match_id=c.match_id AND posx.innings_number=c.innings_number AND posx.batter_id=c.batter_id
LEFT JOIN tinn ON tinn.match_id=c.match_id AND tinn.innings_number=c.innings_number`;
}

// ── Bowling reconstruction ──────────────────────────────────────────────────
function bowlingViewSql(files, scopePredicate, windowPredicate) {
  const src = sourceExpr(files);
  const odi = (col) => `CAST(CASE WHEN bagg.is_hundred=1 THEN NULL ELSE ${col} END AS DOUBLE)`;
  return `
WITH b AS (SELECT * FROM ${src} ${baseWhere(scopePredicate, windowPredicate)}),
os AS (SELECT match_id, innings_number, over_number, bowler_id,
              ANY_VALUE(balls_per_over) bpo,
              SUM(CASE WHEN ${LEGAL} THEN 1 ELSE 0 END) legal_balls,
              SUM(${BRUNS}) conceded
       FROM b WHERE bowler_id IS NOT NULL GROUP BY 1,2,3,4),
maid AS (SELECT match_id, innings_number, bowler_id,
                SUM(CASE WHEN legal_balls=bpo AND conceded=0 THEN 1 ELSE 0 END) maidens
         FROM os GROUP BY 1,2,3),
bo AS (SELECT match_id, innings_number, bowler_id,
              SUM(CASE WHEN legal_balls=6 THEN 1 ELSE 0 END) complete_overs,
              SUM(CASE WHEN legal_balls<6 THEN legal_balls ELSE 0 END) incomplete_balls
       FROM os GROUP BY 1,2,3),
tb AS (SELECT match_id, innings_number,
              SUM(CASE WHEN ${LEGAL} THEN 1 ELSE 0 END) t_balls,
              SUM(${BRUNS}) t_runs,
              SUM(CASE WHEN ${LEGAL} AND runs_batter=0 THEN 1 ELSE 0 END) t_dots
       FROM b GROUP BY 1,2),
tw AS (SELECT match_id, innings_number, SUM(bowler_credited_wkts) t_wkts
       FROM b WHERE bowler_id IS NOT NULL GROUP BY 1,2),
sp_agg AS (SELECT match_id, innings_number, bowler_id, spell_number,
                  SUM(CASE WHEN ${LEGAL} THEN 1 ELSE 0 END) s_balls,
                  SUM(${BRUNS}) s_runs,
                  SUM(bowler_credited_wkts) s_wkts
           FROM b WHERE bowler_id IS NOT NULL GROUP BY 1,2,3,4),
sp AS (SELECT match_id, innings_number, bowler_id,
              MAX(spell_number) spell_count, MAX(s_balls) longest_spell_balls,
              arg_max(s_wkts, s_wkts*1000 - s_runs) best_spell_wkts,
              arg_max(s_runs, s_wkts*1000 - s_runs) best_spell_runs
       FROM sp_agg GROUP BY 1,2,3),
wkk AS (SELECT match_id, innings_number, bowler_id,
               SUM(${kindct("bowled")}) wickets_bowled,
               SUM(${kindct("lbw")}) wickets_lbw,
               SUM(${kindct("caught")}) wickets_caught,
               SUM(${kindct("caught and bowled")}) wickets_caught_and_bowled,
               SUM(${kindct("stumped")}) wickets_stumped,
               SUM(${kindct("hit wicket")}) wickets_hit_wicket
        FROM b WHERE bowler_id IS NOT NULL GROUP BY 1,2,3),
bagg AS (SELECT match_id, innings_number, bowler_id,
                ANY_VALUE(bowler_name) bowler_name, ANY_VALUE(batting_team) batting_team,
                ANY_VALUE(bowling_team) bowling_team, ANY_VALUE(match_type) match_type,
                ANY_VALUE(gender) gender, ANY_VALUE(team_type) team_type,
                ANY_VALUE(match_date) match_date, ANY_VALUE(year) AS "year", ANY_VALUE(month) AS "month",
                MAX(CASE WHEN balls_per_over=5 THEN 1 ELSE 0 END) is_hundred,
                SUM(CASE WHEN ${LEGAL} THEN 1 ELSE 0 END) balls,
                SUM(${BRUNS}) runs_conceded,
                SUM(bowler_credited_wkts) wickets,
                SUM(CASE WHEN ${LEGAL} AND runs_batter=0 THEN 1 ELSE 0 END) dots,
                SUM(CASE WHEN ${B4} THEN 1 ELSE 0 END) fours_conceded,
                SUM(CASE WHEN ${B6} THEN 1 ELSE 0 END) sixes_conceded,
                SUM(COALESCE(wides,0)) wides_runs, SUM(COALESCE(noballs,0)) noball_runs,
                ${bowlPhaseCols(T20P, "")},
                ${bowlPhaseCols(ODIP, "odi_")}
         FROM b WHERE bowler_id IS NOT NULL GROUP BY 1,2,3)
SELECT bagg.match_id, CAST(bagg.innings_number AS INTEGER) AS innings_number, bagg.bowler_id, bagg.bowler_name,
    bagg.bowling_team, bagg.batting_team, bagg.match_type, bagg.gender, bagg.team_type,
    bagg.match_date, CAST(bagg.year AS INTEGER) AS "year", CAST(bagg.month AS INTEGER) AS "month",
    CAST(bagg.balls AS DOUBLE) balls, CAST(bagg.runs_conceded AS DOUBLE) runs_conceded, CAST(bagg.wickets AS DOUBLE) wickets,
    CAST(bagg.dots AS DOUBLE) dots, CAST(bagg.fours_conceded AS DOUBLE) fours_conceded, CAST(bagg.sixes_conceded AS DOUBLE) sixes_conceded,
    CAST(COALESCE(maid.maidens,0) AS DOUBLE) maidens, CAST(bagg.wides_runs AS DOUBLE) wides_runs, CAST(bagg.noball_runs AS DOUBLE) noball_runs,
    CAST(wkk.wickets_bowled AS DOUBLE) wickets_bowled, CAST(wkk.wickets_lbw AS DOUBLE) wickets_lbw, CAST(wkk.wickets_caught AS DOUBLE) wickets_caught,
    CAST(wkk.wickets_caught_and_bowled AS DOUBLE) wickets_caught_and_bowled,
    CAST(wkk.wickets_stumped AS DOUBLE) wickets_stumped, CAST(wkk.wickets_hit_wicket AS DOUBLE) wickets_hit_wicket,
    CAST(bagg.pp_balls AS DOUBLE) pp_balls, CAST(bagg.pp_runs_conceded AS DOUBLE) pp_runs_conceded, CAST(bagg.pp_wickets AS DOUBLE) pp_wickets,
    CAST(bagg.mid_balls AS DOUBLE) mid_balls, CAST(bagg.mid_runs_conceded AS DOUBLE) mid_runs_conceded, CAST(bagg.mid_wickets AS DOUBLE) mid_wickets,
    CAST(bagg.death_balls AS DOUBLE) death_balls, CAST(bagg.death_runs_conceded AS DOUBLE) death_runs_conceded, CAST(bagg.death_wickets AS DOUBLE) death_wickets,
    ${odi("bagg.odi_pp_balls")} odi_pp_balls, ${odi("bagg.odi_pp_runs_conceded")} odi_pp_runs_conceded, ${odi("bagg.odi_pp_wickets")} odi_pp_wickets,
    ${odi("bagg.odi_mid_balls")} odi_mid_balls, ${odi("bagg.odi_mid_runs_conceded")} odi_mid_runs_conceded, ${odi("bagg.odi_mid_wickets")} odi_mid_wickets,
    ${odi("bagg.odi_death_balls")} odi_death_balls, ${odi("bagg.odi_death_runs_conceded")} odi_death_runs_conceded, ${odi("bagg.odi_death_wickets")} odi_death_wickets,
    CAST(bagg.pp_dots AS DOUBLE) pp_dots, CAST(bagg.pp_fours_conceded AS DOUBLE) pp_fours_conceded, CAST(bagg.pp_sixes_conceded AS DOUBLE) pp_sixes_conceded,
    CAST(bagg.mid_dots AS DOUBLE) mid_dots, CAST(bagg.mid_fours_conceded AS DOUBLE) mid_fours_conceded, CAST(bagg.mid_sixes_conceded AS DOUBLE) mid_sixes_conceded,
    CAST(bagg.death_dots AS DOUBLE) death_dots, CAST(bagg.death_fours_conceded AS DOUBLE) death_fours_conceded, CAST(bagg.death_sixes_conceded AS DOUBLE) death_sixes_conceded,
    ${odi("bagg.odi_pp_dots")} odi_pp_dots, ${odi("bagg.odi_pp_fours_conceded")} odi_pp_fours_conceded, ${odi("bagg.odi_pp_sixes_conceded")} odi_pp_sixes_conceded,
    ${odi("bagg.odi_mid_dots")} odi_mid_dots, ${odi("bagg.odi_mid_fours_conceded")} odi_mid_fours_conceded, ${odi("bagg.odi_mid_sixes_conceded")} odi_mid_sixes_conceded,
    ${odi("bagg.odi_death_dots")} odi_death_dots, ${odi("bagg.odi_death_fours_conceded")} odi_death_fours_conceded, ${odi("bagg.odi_death_sixes_conceded")} odi_death_sixes_conceded,
    CAST((bagg.runs_conceded / NULLIF(CAST(CAST(bo.complete_overs AS VARCHAR) || '.' || CAST(bo.incomplete_balls AS VARCHAR) AS DOUBLE),0))
         - (tb.t_runs / NULLIF(tb.t_balls / 6.0, 0)) AS FLOAT) team_rel_econ,
    CAST((bagg.runs_conceded / NULLIF(bagg.balls,0)) - (tb.t_runs / NULLIF(tb.t_balls,0)) AS FLOAT) team_rel_pbe,
    CAST((bagg.dots / NULLIF(bagg.balls,0) * 100.0) - (tb.t_dots / NULLIF(tb.t_balls,0) * 100.0) AS FLOAT) team_rel_dot_pct,
    CAST((bagg.balls / NULLIF(bagg.wickets,0)) - (tb.t_balls / NULLIF(tw.t_wkts,0)) AS FLOAT) team_rel_sr,
    CAST(COALESCE(sp.spell_count,0) AS DOUBLE) spell_count, CAST(COALESCE(sp.longest_spell_balls,0) AS DOUBLE) longest_spell_balls,
    CAST(COALESCE(sp.best_spell_wkts,0) AS BIGINT) best_spell_wkts, CAST(COALESCE(sp.best_spell_runs,0) AS DOUBLE) best_spell_runs
FROM bagg
LEFT JOIN maid ON maid.match_id=bagg.match_id AND maid.innings_number=bagg.innings_number AND maid.bowler_id=bagg.bowler_id
LEFT JOIN bo   ON bo.match_id=bagg.match_id AND bo.innings_number=bagg.innings_number AND bo.bowler_id=bagg.bowler_id
LEFT JOIN wkk  ON wkk.match_id=bagg.match_id AND wkk.innings_number=bagg.innings_number AND wkk.bowler_id=bagg.bowler_id
LEFT JOIN sp   ON sp.match_id=bagg.match_id AND sp.innings_number=bagg.innings_number AND sp.bowler_id=bagg.bowler_id
LEFT JOIN tb   ON tb.match_id=bagg.match_id AND tb.innings_number=bagg.innings_number
LEFT JOIN tw   ON tw.match_id=bagg.match_id AND tw.innings_number=bagg.innings_number`;
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
 *   the raw ball columns; EMPTY in Wave 2a (present-but-unused hook).
 * @returns {string} a SELECT producing exactly the columns (names, order, types)
 *   of batting_innings.parquet / bowling_innings.parquet.
 */
export function buildInningsViewSql(discipline, { files, scopePredicate = "", windowPredicate = "" } = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("ballEngine.buildInningsViewSql: files[] is required");
  }
  if (discipline === "batting") return battingViewSql(files, scopePredicate, windowPredicate);
  if (discipline === "bowling") return bowlingViewSql(files, scopePredicate, windowPredicate);
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
