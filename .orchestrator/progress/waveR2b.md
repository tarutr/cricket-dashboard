# Wave R2b — filter-rejig CORRECTIVE rework (palette fixes + PotM + query-builder completion)

Branch `ball-layer`. Corrective pass over the R2 palette (`buildPaletteGroups` in
`src/drawer.js`). Owned: `src/drawer.js`, `src/metrics.js` (potm_count only),
`styles.css`, `src/table.js` (conditionToHaving ONLY), `src/filters.js`
(buildScopeClauses ONLY). Authoritative filter list: `.orchestrator/filter-rejig-spec.md`.

## PHASE 1 — structure fixes + PotM Count (COMMIT `wip(waveR2b-fixes):`)
- **PotM Count** (`potm_count`) added to metrics.js (in FIELDING_METRIC_SPECS next to
  `player_of_match`, section "impact", pushed to both disciplines). sqlExpression
  `MAX(pom_cte.player_of_match)`. NOTE the brief said "SUM not MAX" — see the MAX-vs-SUM
  finding below; the CTE already SUMs the flag, MAX is only the GROUP-BY projection.
  Placed as `leafMetric("potm_count","PotM Count")` in Player Profile between Regular
  batting position and Team. Independently verified: SA Yadav = 5, Karanbir Singh = 11
  (== raw SUM of the 0/1 flag on player_matches). End-to-end filter test: PotM Count ≥ 10
  → 6 players (Virandeep Singh/Sikandar Raza/Bilal Zalmai/Karanbir Singh/K Bhurtel/Asif
  Ali) == independent DuckDB query. The old `player_of_match` (MAX) stays as a COLUMN but
  is no longer a filter (parts.impact spread removed from Fielding).
- **4-WI / 5-WI removed** from Bowling Basic (defs stay as columns); only Wicket Hauls ≥ N ▸.
- **leftoverLeaves catch-all removed** (function + both call sites + the now-dead `placed`
  set). Palette shows EXACTLY the target list. Plain-namespace leftover = NONE. Matchup-
  namespace leftover (now excluded in Vs mode) = **matchup_batting: Balls Faced, Dismissals;
  matchup_bowling: Fours Conceded, Sixes Conceded** — FLAGGED for owner (see report).
- **Fielding Stats = exactly the two ▸ families** (Fielding Wicket Type, Wickets by Batting
  Position). Removed the standalone Catches/Stumpings/Run-outs (parts.fielding) and Player
  of the Match (parts.impact) count leaves. FLAG: "catches ≥ N" no longer expressible until
  Fielding Wicket Type ▸ gains a count operator (spec intent; not in this brief).

Verified flag-OFF: anchors on screen (2,813 players / Karanbir Singh 2,454 runs); both
surfaces (Stats popup + Graph popup) show the corrected palette name-for-name; PotM Count
filter works; 0 console errors; 375px no horizontal overflow.

## PHASE 2 — query-builder completion (COMMIT `wip(waveR2b-qb):`)
1. **Innings Score ≥ N ▸ / Wicket Hauls ≥ N ▸ real N input** — (owned files only).
   conditionRowHTML renders an inline N input for param metrics (metric.paramTemplate +
   metric.param); wired via the existing v1/v2 input handler (extended to data-role="n").
   `conditionToHaving` (table.js) uses `paramSqlExpression(metric, cond.n)` for param
   metrics, else `metric.sqlExpression`. ADDITIVE: cond.n lives inside state.advanced
   (whole-object serialized by serializeQueryState), and an undefined n falls back to the
   default sqlExpression → byte-identical when no N is set. Verified: innings_score_ge(50)=12,
   (100)=1, wicket_hauls_ge(3)=15 for known players == independent DuckDB.
2. **Innings Number ▸** — BLOCKED by file ownership; NOT built. A new top-level scope filter
   needs (a) a key in `serializeQueryState` (table.js, restricted to conditionToHaving here —
   without it the Search button never lights + the render cache goes stale), (b) state.js
   plumbing (default, describeScope pill, activeFilterCount, discipline archiving), and (c) a
   row editor. buildScopeClauses (owned) is only ONE of ~5 pieces. Per the brief's own guard
   ("remove Innings order only once Innings Number works"), **"Innings order" is KEPT** in
   Match Details — no gap. See report for the precise implementation plan.

## Key finding — PotM Count "SUM vs MAX"
`buildPomCteSql` already computes `SUM(player_of_match)` per player (the award count). The
metric's sqlExpression is only the OUTER projection of that constant out of the batting/
bowling GROUP BY, which MUST be a collapsing aggregate (MAX, like R.Pos/fielding/the existing
player_of_match). A literal outer `SUM(pom_cte.player_of_match)` would multiply the count by
the batter's innings-row count (SA Yadav → 5×60=300, WRONG). Since I cannot touch
buildPomCteSql (table.js conditionToHaving-only), `MAX(pom_cte.player_of_match)` is the sole
correct implementation. Value == the SUM/count the owner wants (verified). Consequence: it
equals the existing `player_of_match` column exactly, so both appear in the column picker
under Impact (the picker is in table.js openColumnsPopover, not owned) — the columns rejig
(next in the spec sequence) is the place to dedupe.
