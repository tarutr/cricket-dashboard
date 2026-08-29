// src/ballColumns.js
//
// Ball-grain rebuild — Wave 2s (speed), owner decision 67 "SPEED PULLED FORWARD".
//
// THE VOCABULARY + THE DERIVATION RULE for query-shaped reconstruction.
//
// Wave 2a's ball engine rebuilt ALL 74 batting / 71 bowling innings columns on
// every search, when a search reads ~8–12 of them — ~19.8 s in DuckDB-WASM.
// Layer 1 makes the reconstruction QUERY-SHAPED: db.js hands ballEngine.js the
// exact set of innings-grain columns the SQL about to run actually references,
// and the engine emits only those aggregates and only the CTEs they need.
//
// ── Why deriving from the SQL TEXT is safe ──────────────────────────────────
// SQL cannot read a column without naming it — EXCEPT through a star expansion
// (`SELECT *`, `t.*`, `COLUMNS(...)`, `NATURAL JOIN`). So:
//   • token-scan the SQL for the FIXED vocabulary below → a set that is a
//     SUPERSET of what the query needs (string literals and unrelated tables
//     can only ADD names — false positives cost a little speed, never a wrong
//     answer);
//   • detect star expansions and fall back to the FULL column set, naming the
//     construct in a console.warn (src/graph/timeseries.js genuinely does
//     `SELECT * FROM <ns>` for two Line x-dimensions).
// A missed column can therefore only come from a construct this module does not
// know about, and it surfaces as a DuckDB Binder Error ("column not found"),
// never as a silently wrong number. db.js catches that error, rebuilds the views
// with the full set, warns loudly, and retries once (see runWithColumnRetry).
//
// Keys + context columns are ALWAYS emitted (they are the view's identity and
// every query's scope/grouping), so the pruned view is always usable.
//
// ── ROW-SET RULE (correctness-critical) ─────────────────────────────────────
// Pruning removes COLUMNS ONLY, never rows. Innings counts are COUNT(*) over
// view rows, so the batting `crease` CTE (the batter/non-striker/player-out/
// wickets_extra union) and the bowling `bagg` grain must be built identically
// whatever is pruned — see ballEngine.js, which keeps every row-set input in
// its base projection unconditionally.

/** batting_innings.parquet's column list, in export order (the FIXED vocabulary). */
export const BATTING_VIEW_COLUMNS = [
  "match_id",
  "innings_number",
  "batter_id",
  "batter_name",
  "batting_team",
  "bowling_team",
  "match_type",
  "gender",
  "team_type",
  "match_date",
  "year",
  "month",
  "runs",
  "balls_faced",
  "dots",
  "fours_hit",
  "sixes_hit",
  "dismissed",
  "dismissal_kind",
  "batting_position",
  "pp_runs",
  "pp_balls",
  "mid_runs",
  "mid_balls",
  "death_runs",
  "death_balls",
  "odi_pp_runs",
  "odi_pp_balls",
  "odi_mid_runs",
  "odi_mid_balls",
  "odi_death_runs",
  "odi_death_balls",
  "fb1_10_runs",
  "fb1_10_balls",
  "fb11_20_runs",
  "fb11_20_balls",
  "fb21p_runs",
  "fb21p_balls",
  "pp_dots",
  "pp_fours",
  "pp_sixes",
  "pp_dismissals",
  "mid_dots",
  "mid_fours",
  "mid_sixes",
  "mid_dismissals",
  "death_dots",
  "death_fours",
  "death_sixes",
  "death_dismissals",
  "odi_pp_dots",
  "odi_pp_fours",
  "odi_pp_sixes",
  "odi_pp_dismissals",
  "odi_mid_dots",
  "odi_mid_fours",
  "odi_mid_sixes",
  "odi_mid_dismissals",
  "odi_death_dots",
  "odi_death_fours",
  "odi_death_sixes",
  "odi_death_dismissals",
  "ones",
  "twos",
  "threes",
  "fives",
  "nb_fours",
  "nb_sixes",
  "non_boundary_runs",
  "team_inns_balls",
  "team_rel_sr",
  "team_rel_dot_pct",
  "team_rel_bpb",
  "team_rel_nbsr",
  // Cutover S1 (ball-engine-gated which-values, Stage-3 Phase 8) — per-innings LIST
  // columns feeding the Ball-Ranges / vs-Opponent which-values leaderboard columns
  // (metrics.js resolveWindowSetMetric). NOT in the export parquet — reconstruction-only,
  // appended AFTER the export columns so *_ALWAYS_COLUMNS (slice 0–12) is untouched and
  // they are emitted ONLY when the query names them (neededViewColumns token-scan), so
  // an unrelated query's reconstruction is byte-identical. Player-LOCAL (each reads only
  // this batter's own striker deliveries), so deliberately NOT added to the whole-innings
  // list. w_pball_list carries bat_ball here (bowl_ball on the bowling view).
  "w_phase_list",
  "w_over_list",
  "w_tball_list",
  "w_pball_list",
  "w_opp_list",
];

/** bowling_innings.parquet's column list, in export order. */
export const BOWLING_VIEW_COLUMNS = [
  "match_id",
  "innings_number",
  "bowler_id",
  "bowler_name",
  "bowling_team",
  "batting_team",
  "match_type",
  "gender",
  "team_type",
  "match_date",
  "year",
  "month",
  "balls",
  "runs_conceded",
  "wickets",
  "dots",
  "fours_conceded",
  "sixes_conceded",
  "maidens",
  "wides_runs",
  "noball_runs",
  "wickets_bowled",
  "wickets_lbw",
  "wickets_caught",
  "wickets_caught_and_bowled",
  "wickets_stumped",
  "wickets_hit_wicket",
  "pp_balls",
  "pp_runs_conceded",
  "pp_wickets",
  "mid_balls",
  "mid_runs_conceded",
  "mid_wickets",
  "death_balls",
  "death_runs_conceded",
  "death_wickets",
  "odi_pp_balls",
  "odi_pp_runs_conceded",
  "odi_pp_wickets",
  "odi_mid_balls",
  "odi_mid_runs_conceded",
  "odi_mid_wickets",
  "odi_death_balls",
  "odi_death_runs_conceded",
  "odi_death_wickets",
  "pp_dots",
  "pp_fours_conceded",
  "pp_sixes_conceded",
  "mid_dots",
  "mid_fours_conceded",
  "mid_sixes_conceded",
  "death_dots",
  "death_fours_conceded",
  "death_sixes_conceded",
  "odi_pp_dots",
  "odi_pp_fours_conceded",
  "odi_pp_sixes_conceded",
  "odi_mid_dots",
  "odi_mid_fours_conceded",
  "odi_mid_sixes_conceded",
  "odi_death_dots",
  "odi_death_fours_conceded",
  "odi_death_sixes_conceded",
  "team_rel_econ",
  "team_rel_pbe",
  "team_rel_dot_pct",
  "team_rel_sr",
  "spell_count",
  "longest_spell_balls",
  "best_spell_wkts",
  "best_spell_runs",
  // Cutover S1 (ball-engine-gated which-values, Stage-3 Phase 8) — the bowling mirror of
  // the batting per-innings LIST columns above (reconstruction-only, appended after the
  // export columns; ALWAYS slice untouched; emitted only when named). w_pball_list carries
  // bowl_ball here; w_opp_list carries the BATTERS this bowler faced.
  "w_phase_list",
  "w_over_list",
  "w_tball_list",
  "w_pball_list",
  "w_opp_list",
];

/** Keys + denormalised scope/context — ALWAYS emitted, whatever the query asks
 * for. They are the view's identity (join keys, GROUP BY keys) and every
 * query's scope predicate reads them. */
export const BATTING_ALWAYS_COLUMNS = BATTING_VIEW_COLUMNS.slice(0, 12);
export const BOWLING_ALWAYS_COLUMNS = BOWLING_VIEW_COLUMNS.slice(0, 12);

// ── Matchup view vocabularies (Wave 2b, owner decision 67) ───────────────────
// matchup_batting.parquet / matchup_bowling.parquet column lists, in export
// order (source of truth: export_parquet.py sql_matchup_batting/bowling final
// SELECTs — confirmed cell-for-cell against the shipped parquet schemas). The
// ball engine's matchup reconstruction (src/ballEngineMatchup.js) is pruned
// against these exactly as the plain views are against the two lists above.

/** matchup_batting.parquet's column list, in export order. Grain: one row per
 * (match_id, innings_number, batter_id, bowling_type) — keyed by the BOWLER's
 * mapped style. bowling_group is functionally determined by bowling_type. */
export const MATCHUP_BATTING_VIEW_COLUMNS = [
  "match_id",
  "innings_number",
  "batter_id",
  "bowling_type",
  "bowling_group",
  "batter_name",
  "batting_team",
  "bowling_team",
  "match_type",
  "gender",
  "team_type",
  "match_date",
  "year",
  "month",
  "runs",
  "balls_faced",
  "dots",
  "fours_hit",
  "sixes_hit",
  "dismissals",
  "dis_bowled",
  "dis_lbw",
  "dis_caught",
  "dis_caught_and_bowled",
  "dis_stumped",
  "dis_hit_wicket",
  "pp_runs",
  "pp_balls",
  "mid_runs",
  "mid_balls",
  "death_runs",
  "death_balls",
  "odi_pp_runs",
  "odi_pp_balls",
  "odi_mid_runs",
  "odi_mid_balls",
  "odi_death_runs",
  "odi_death_balls",
  "pp_dots",
  "pp_fours",
  "pp_sixes",
  "pp_dismissals",
  "mid_dots",
  "mid_fours",
  "mid_sixes",
  "mid_dismissals",
  "death_dots",
  "death_fours",
  "death_sixes",
  "death_dismissals",
  "odi_pp_dots",
  "odi_pp_fours",
  "odi_pp_sixes",
  "odi_pp_dismissals",
  "odi_mid_dots",
  "odi_mid_fours",
  "odi_mid_sixes",
  "odi_mid_dismissals",
  "odi_death_dots",
  "odi_death_fours",
  "odi_death_sixes",
  "odi_death_dismissals",
  "batting_position",
  "ones",
  "twos",
  "threes",
  "fives",
  "nb_fours",
  "nb_sixes",
  "non_boundary_runs",
  "team_rel_sr",
  "team_rel_dot_pct",
  "team_rel_bpb",
  "team_rel_nbsr",
  // Cutover S1 (ball-engine-gated vs-PotMs axis, decision 81) — vs_potm = '1' iff
  // the BOWLER on the delivery won Player-of-the-Match of that match, else '0'.
  // Reconstruction-only (the R2 export parquet, rebuilt from main, lacks it),
  // appended AFTER the export columns so the ALWAYS slice (0–14) is untouched.
  // GRAIN-SPLITTING (see GRAIN_SPLIT_COLUMNS): emitted ONLY when the query names
  // it (the potm axis is active), so an unrelated reconstruction keeps the export
  // (…, bowling_type) grain byte-identical and reconciles cell-for-cell.
  "vs_potm",
];

/** matchup_bowling.parquet's column list, in export order. Grain: one row per
 * (match_id, innings_number, bowler_id, batting_hand, batting_position) —
 * batting_position (the STRIKER's position faced) is part of the primary key. */
export const MATCHUP_BOWLING_VIEW_COLUMNS = [
  "match_id",
  "innings_number",
  "bowler_id",
  "batting_hand",
  "batting_position",
  "bowler_name",
  "batting_team",
  "bowling_team",
  "match_type",
  "gender",
  "team_type",
  "match_date",
  "year",
  "month",
  "balls",
  "runs_conceded",
  "wickets",
  "dots",
  "fours_conceded",
  "sixes_conceded",
  "wkt_bowled",
  "wkt_lbw",
  "wkt_caught",
  "wkt_caught_and_bowled",
  "wkt_stumped",
  "wkt_hit_wicket",
  "pp_balls",
  "pp_runs_conceded",
  "pp_wickets",
  "mid_balls",
  "mid_runs_conceded",
  "mid_wickets",
  "death_balls",
  "death_runs_conceded",
  "death_wickets",
  "odi_pp_balls",
  "odi_pp_runs_conceded",
  "odi_pp_wickets",
  "odi_mid_balls",
  "odi_mid_runs_conceded",
  "odi_mid_wickets",
  "odi_death_balls",
  "odi_death_runs_conceded",
  "odi_death_wickets",
  "pp_dots",
  "pp_fours_conceded",
  "pp_sixes_conceded",
  "mid_dots",
  "mid_fours_conceded",
  "mid_sixes_conceded",
  "death_dots",
  "death_fours_conceded",
  "death_sixes_conceded",
  "odi_pp_dots",
  "odi_pp_fours_conceded",
  "odi_pp_sixes_conceded",
  "odi_mid_dots",
  "odi_mid_fours_conceded",
  "odi_mid_sixes_conceded",
  "odi_death_dots",
  "odi_death_fours_conceded",
  "odi_death_sixes_conceded",
  "team_rel_econ",
  "team_rel_pbe",
  "team_rel_dot_pct",
  "team_rel_sr",
  // Cutover S1 (ball-engine-gated vs-PotMs axis, decision 81) — vs_potm = '1' iff
  // the BATTER on the delivery (the bowler's opponent) won Player-of-the-Match of
  // that match, else '0'. Reconstruction-only, appended after the export columns;
  // GRAIN-SPLITTING (see GRAIN_SPLIT_COLUMNS), emitted only when named.
  "vs_potm",
];

/** Keys + denormalised scope/context — ALWAYS emitted. For the matchup views
 * these are the leading 14 columns: the primary-key columns (incl. the derived
 * style key bowling_type/batting_hand and, for bowling, the striker
 * batting_position) plus bowling_group and every denormalised scope column the
 * outer query's WHERE reads (gender / match_type / team_type / match_date …). */
export const MATCHUP_BATTING_ALWAYS_COLUMNS = MATCHUP_BATTING_VIEW_COLUMNS.slice(0, 14);
export const MATCHUP_BOWLING_ALWAYS_COLUMNS = MATCHUP_BOWLING_VIEW_COLUMNS.slice(0, 14);

// ── Grain-splitting reconstruction columns (Cutover S1, decision 81) ─────────
// Columns that, when emitted, ADD a key to the matchup GROUP BY — so they change
// the reconstruction ROW SET, unlike every other prunable column (which only adds
// an aggregate at the fixed grain). They are therefore emitted ONLY when a query
// NAMES them (the vs-PotMs axis is active): they are in the vocabulary above (so
// neededViewColumns' token scan requests them on demand) but are DELIBERATELY
// EXCLUDED from the null/full default set (ballEngineMatchup.js wantedColumns), so
// a `SELECT *` / star-expansion reconstruction keeps the export
// (…, bowling_type) / (…, batting_position) grain byte-identical — the module's
// cell-for-cell reconciliation against the shipped parquet is untouched.
export const GRAIN_SPLIT_COLUMNS = new Set(["vs_potm"]);

// ── Player-local vs whole-innings split (Wave 2s2 FIX 1) ─────────────────────
// A reconstructed innings column is "player-LOCAL" when its value depends only
// on that player's OWN deliveries (their striker/appearance balls for batting,
// their bowled balls for bowling) — runs, balls, dots, boundaries, phase splits,
// dismissals, wicket types, spells, etc. It is "WHOLE-INNINGS" when it needs the
// team's ENTIRE innings' balls: the team-innings ball total and every
// team-relative differential (the player's rate MINUS the whole side's rate).
//
// This split is what makes db.js's popup player-scoping (restricting the base
// ball set to one player's involvement) BYTE-IDENTICAL: with a player-scoped
// base the per-player CTEs (`bat`/`bagg`/`dis`/`wkk`/…) still see every one of
// that player's own balls, so their aggregates are complete; but the team-total
// CTEs (`tinn`/`tb`/`tw`) would see only a fraction of the innings and go wrong.
// Rule: player-scope the reconstruction ONLY when NONE of these columns is
// needed; otherwise fall back to the whole-scope (team-complete) reconstruction.
export const BATTING_WHOLE_INNINGS_COLUMNS = [
  "team_inns_balls",
  "team_rel_sr",
  "team_rel_dot_pct",
  "team_rel_bpb",
  "team_rel_nbsr",
];
export const BOWLING_WHOLE_INNINGS_COLUMNS = [
  "team_rel_econ",
  "team_rel_pbe",
  "team_rel_dot_pct",
  "team_rel_sr",
];
// Matchup team-relative differentials are whole-innings too: each needs the
// WHOLE side's aggregate against that bowling_type (batting) / (batting_hand,
// batting_position) (bowling) this innings — every batter/bowler in it — so a
// player-scoped base ball set (one player's balls) would compute them wrong.
export const MATCHUP_BATTING_WHOLE_INNINGS_COLUMNS = [
  "team_rel_sr",
  "team_rel_dot_pct",
  "team_rel_bpb",
  "team_rel_nbsr",
];
export const MATCHUP_BOWLING_WHOLE_INNINGS_COLUMNS = [
  "team_rel_econ",
  "team_rel_pbe",
  "team_rel_dot_pct",
  "team_rel_sr",
];

/** The whole-innings (NOT player-local) column list for a discipline. */
export function wholeInningsColumnsFor(discipline) {
  if (discipline === "batting") return BATTING_WHOLE_INNINGS_COLUMNS;
  if (discipline === "bowling") return BOWLING_WHOLE_INNINGS_COLUMNS;
  if (discipline === "matchup_batting") return MATCHUP_BATTING_WHOLE_INNINGS_COLUMNS;
  if (discipline === "matchup_bowling") return MATCHUP_BOWLING_WHOLE_INNINGS_COLUMNS;
  throw new Error(`ballColumns: unknown discipline "${discipline}"`);
}

/** True when every column a query needs is player-LOCAL — i.e. the base ball set
 * may safely be restricted to a single player without moving any number. `need`
 * is a neededViewColumns() result. The FULL set (null columns) is NEVER
 * player-local: it includes the whole-innings team-relative columns. */
export function columnsArePlayerLocal(discipline, need) {
  if (!need || need.full || !need.columns) return false;
  const whole = new Set(wholeInningsColumnsFor(discipline));
  for (const c of need.columns) if (whole.has(c)) return false;
  return true;
}

/** The ball-row (delivery parquet) schema v1 — the vocabulary ballEngine.js
 * scans its own generated SQL against to build the LEAN base projection
 * (Layer 2). Order matches the exporter's `sql_deliveries`. */
export const DELIVERY_COLUMNS = [
  "match_id",
  "innings_number",
  "over_number",
  "ball_index",
  "team_ball",
  "is_super_over",
  "match_type",
  "gender",
  "team_type",
  "match_date",
  "year",
  "month",
  "batting_team",
  "bowling_team",
  "balls_per_over",
  "runs_batter",
  "wides",
  "noballs",
  "byes",
  "legbyes",
  "penalty",
  "is_not_boundary",
  "wicket_kind",
  "player_out_id",
  "bowler_credited",
  "batter_id",
  "batter_name",
  "non_striker_id",
  "batting_position",
  "bat_ball",
  "bat_ball_rev",
  "bowler_id",
  "bowler_name",
  "bowl_ball",
  "bowl_ball_rev",
  "spell_number",
  "phase",
  "non_striker_name",
  "non_striker_position",
  "bowler_credited_wkts",
  "wickets_extra",
];

export function viewColumnsFor(discipline) {
  if (discipline === "batting") return BATTING_VIEW_COLUMNS;
  if (discipline === "bowling") return BOWLING_VIEW_COLUMNS;
  if (discipline === "matchup_batting") return MATCHUP_BATTING_VIEW_COLUMNS;
  if (discipline === "matchup_bowling") return MATCHUP_BOWLING_VIEW_COLUMNS;
  throw new Error(`ballColumns: unknown discipline "${discipline}"`);
}

export function alwaysColumnsFor(discipline) {
  if (discipline === "batting") return BATTING_ALWAYS_COLUMNS;
  if (discipline === "bowling") return BOWLING_ALWAYS_COLUMNS;
  if (discipline === "matchup_batting") return MATCHUP_BATTING_ALWAYS_COLUMNS;
  if (discipline === "matchup_bowling") return MATCHUP_BOWLING_ALWAYS_COLUMNS;
  throw new Error(`ballColumns: unknown discipline "${discipline}"`);
}

/** Replace every single-quoted string literal with an empty one, so literal
 * TEXT (team names, search terms, dismissal kinds) can neither be mistaken for
 * an identifier nor for a star expansion. `''` inside a literal is an escaped
 * quote (SQL standard) and is consumed by the alternation. */
function stripStringLiterals(sql) {
  return String(sql).replace(/'(?:[^']|'')*'/g, "''");
}

/** Every identifier-shaped token in the SQL, with string literals removed first.
 * Double-quoted identifiers ("year", "month") need no special case — the inner
 * word is a token in its own right. Also used by ballEngine.js to derive the
 * LEAN base ball projection from its own generated SQL (Layer 2). */
export function sqlIdentifierTokens(sql) {
  return new Set(stripStringLiterals(sql).match(/[A-Za-z_][A-Za-z0-9_]*/g) || []);
}

// A star EXPANSION (as opposed to arithmetic `*` or the `COUNT(*)` aggregate
// star) is the only way SQL reads a column without naming it. It is always
// preceded — ignoring whitespace — by SELECT, DISTINCT, a comma, or a qualifying
// dot: `SELECT *`, `SELECT DISTINCT *`, `SELECT *, ROW_NUMBER() …`, `base.*`.
// Arithmetic `*` always follows an operand (identifier / number / `)`), and
// `COUNT(*)`'s star follows `(` — neither can match.
const STAR_EXPANSION_RE = /(?:\bselect\b|\bdistinct\b|,|\.)\s*\*/i;
// Other constructs that can pull in unnamed columns.
const DYNAMIC_COLUMN_RE = /\bcolumns\s*\(|\bnatural\s+join\b/i;

/**
 * Derive the innings-grain columns `discipline`'s reconstructed view must emit
 * for `sql` to run.
 *
 * @param {"batting"|"bowling"} discipline
 * @param {string} sql  the exact SQL about to be executed against the view
 * @returns {{columns: string[]|null, full: boolean, reason: string|null}}
 *   `columns` = the needed set (always includes the keys/context columns);
 *   `full: true` with `columns: null` means "emit everything" and `reason`
 *   names the construct that forced it (db.js console.warns it).
 */
export function neededViewColumns(discipline, sql) {
  const vocab = viewColumnsFor(discipline);
  const always = alwaysColumnsFor(discipline);
  const text = stripStringLiterals(sql);

  const star = text.match(STAR_EXPANSION_RE);
  if (star) {
    return { columns: null, full: true, reason: `star expansion "${star[0].replace(/\s+/g, " ")}"` };
  }
  const dyn = text.match(DYNAMIC_COLUMN_RE);
  if (dyn) {
    return { columns: null, full: true, reason: `dynamic column construct "${dyn[0]}"` };
  }

  const toks = sqlIdentifierTokens(sql);
  const need = new Set(always);
  for (const col of vocab) if (toks.has(col)) need.add(col);
  // Preserve export order — purely cosmetic, but it keeps generated SQL and
  // DESCRIBE output readable next to the shipped parquet schema.
  return { columns: vocab.filter((c) => need.has(c)), full: false, reason: null };
}

/** Signature string for a column set — the cache key component (order-stable). */
export function columnSetKey(columns) {
  if (!columns) return "*";
  return columns.slice().sort().join(",");
}

/** True when `have` covers every column in `want` (superset-compatible cache
 * reuse: a table materialised with MORE columns answers a query needing fewer). */
export function coversColumns(have, want) {
  if (!have) return true; // `null` = the full set, covers everything
  if (!want) return false; // need everything, have only a subset
  const h = have instanceof Set ? have : new Set(have);
  for (const c of want) if (!h.has(c)) return false;
  return true;
}

/** Union of two column sets (`null` = full set absorbs everything). */
export function unionColumns(a, b) {
  if (!a || !b) return null;
  const out = new Set(a);
  for (const c of b) out.add(c);
  return [...out];
}
