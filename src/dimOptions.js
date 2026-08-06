// src/dimOptions.js
//
// Generic, reusable DATA-DRIVEN option loader (T-3a-ext). Returns the distinct
// non-null values of a column on a source, WITHIN the same core scope the queries
// use — so the options a picker offers can never disagree with what the query would
// count. Built as a standalone helper because a later retrofit reuses it for the
// leaderboard's matchup-Vs opponent list + the player-profile filters; the fielding
// tab (T-3b) is its first caller.
//
// THE DATA-DRIVEN AVAILABILITY RULE (owner, T-3a-ext — NO gender hardcoding): a
// profile-derived dim (out_hand / out_role / bowler_style) is offered ONLY when this
// loader returns a non-empty list for the current scope. Men have profile values →
// options present → the filter shows; women have none (every value is NULL) → [] →
// the filter is absent. When women's profiles land, options appear and the filter
// auto-shows. No `if (!women)` anywhere — the DATA decides.

import { query } from "./db.js";
import { buildCoreScopeClauses } from "./filters.js";

/**
 * Distinct non-null values of `column` on `source`, within `scope`.
 *
 * @param {string} source  A registered view/table name (e.g. "fielding", "matches",
 *   "matchup_batting"). Trusted caller-supplied identifier — NOT user input.
 * @param {string} column  The column to enumerate. Trusted identifier — NOT user input.
 * @param {object} scope   { gender, formats, teamType, dateFrom, dateTo } — mapped
 *   through the SAME buildCoreScopeClauses the number-critical queries use, so the
 *   options offered are exactly the values in the scope the count would see. Any
 *   field omitted simply drops its clause (formats MUST be a non-empty array, else
 *   buildCoreScopeClauses emits FALSE and the result is [] — by design: no format,
 *   no rows). NULLs and empty strings are excluded (a NULL profile value is "no
 *   data", never an option) — so an EMPTY result is the data-driven "hide" signal.
 * @returns {Promise<Array<string|number>>} Distinct values, ascending.
 */
export async function loadDimOptions(source, column, scope = {}) {
  const scopeState = {
    gender: scope.gender,
    formats: scope.formats,
    teamType: scope.teamType,
    dateFrom: scope.dateFrom,
    dateTo: scope.dateTo,
  };
  const core = buildCoreScopeClauses(scopeState).join(" AND ");
  // Only IS NOT NULL in SQL (works for any column TYPE — a numeric-column caller
  // must not hit a `col <> ''` cast error); empty strings are dropped JS-side below,
  // so a VARCHAR column's "" values still never become options.
  const where = core ? `${core} AND ${column} IS NOT NULL` : `${column} IS NOT NULL`;
  const sql = `SELECT DISTINCT ${column} AS v FROM ${source} WHERE ${where} ORDER BY 1`;
  const { rows } = await query(sql);
  return rows.map((r) => r.v).filter((v) => v != null && v !== "");
}
