# Wave R2c — filter-rejig: Innings Number + Fielding count operator + matchup restores

Branch `ball-layer`. Finished the two R2b blockers (Innings Number, Fielding count)
plus a coordinator-added third task (restore 4 matchup-namespace filters). All
ADDITIVE / numbers-sacred; anchors byte-identical flag-OFF. Independent DuckDB
checks in `.orchestrator/verify_waveR2c.py` (ALL PASS).

## TASK 1 — Innings Number scope filter (commit `wip(waveR2c-innno):`)
New top-level scope filter `state.inningsNumber` (1-based DISPLAY ints), mirroring
an existing categorical scope filter END-TO-END:
- `state.js`: default `inningsNumber: []`; `inningsNumberLabel`/`inningsNumberOptions`
  (format-aware: 2 white-ball / up to 4 when Red Ball selected) / `inningsNumberFilterActive`;
  describeScope token ("Innings: 1st innings"). Persists across discipline toggle like
  Innings order (no archiving change needed — same value concept both disciplines).
- `filters.js` `buildScopeClausesTagged`: emits `innings_number IN (<stored>)` via
  `INNINGS_NUMBER_FILTER.toStored` (0-BASED: display 1 → stored 0). ALWAYS-APPLIES
  (selects which innings are measured; pins obey). Emitted ONLY for the batting/bowling
  innings-grain views — keyed off `teamColumn ∈ {batting_team, bowling_team}` (a Set
  const) so the pom_cte (player_matches) and fielding_cte (fielding) queries, which
  have no `innings_number` column, never see it. R.Pos inner scope passes no teamColumn
  → correctly excluded. Empty ⇒ no clause ⇒ byte-identical.
- `table.js` `serializeQueryState`: added `inningsNumber` so Search lights + render cache keys on it.
  (`buildQuery`/`buildMatchupQuery`/`conditionToHaving` untouched.)
- `drawerInnings.js`: `mountInningsNumber` — format-aware checkbox multi-select; keeps
  any picked-but-out-of-scope value visible (no invisible pick; never rewrites a pick).
- `drawer.js`: `inn_num` singleton + `Innings Number ▸` singleFamily placed right after
  "Innings" in Batting AND Bowling Basic Stats; controller mount / hasValue / clearSingleton
  / sync / activeCount / preselect closure.
- `drawer.js`: **"Innings order" (mc_innings_order) REMOVED from the Match Details palette**
  (no gap — Innings Number took its slot). The mc_innings_order row/editor/pill plumbing is
  retained (unreachable, inert) — full teardown touches non-owned files (see Flags).
- `pills.js` + `graph/graph.js` (beyond owned set — required for end-to-end / both surfaces):
  removable pill "Innings: …"; graph "Apply to graph" commit-list + scopeSeedKey entries.

Independent verify: anchors unchanged (2813 / Karanbir 2454 / SA Yadav 60·1544·29.13·150.34);
SA Yadav innings-1 (innings_number=0) = **38** via the view AND an independent raw-ball
derivation; innings-1 + innings-2 = 60. In-app (flag-OFF, Men/Batting/T20/Intl, anchor dates):
adding Innings Number = 1st innings → SA Yadav 38 inns, count 2,813 → 2,558; pill shows;
0 console errors; 375px no overflow.

## TASK 2 — Fielding Wicket Type ▸ count operator (commit `wip(waveR2c-fldcount):`)
Rebuilt `drawer.js` "Fielding Wicket Type ▸" from a categorical preselect (`fld_kind`) into a
COUNT sub-filter: each kind maps to its existing fielding-count metric and adds a NUMERIC
condition (flows through the UNCHANGED fielding_cte join + conditionToHaving):
- **Caught → `catches`, Run-out → `run_outs`, Stumped → `stumpings`** (enabled leaves).
- Restores the Catches/Stumpings/Run-outs count filtering R2b removed as standalone leaves.
- `metrics.js` UNTOUCHED (metrics already exist); `conditionToHaving` UNTOUCHED.

**Caught & bowled — FLAGGED, not guessed.** No distinct fielding count exists: in
`buildFieldingCteSql` (table.js, OUTSIDE this wave's ownership) `catches` folds c&b in
(`kind IN ('caught','caught and bowled')`). Independent verify shows it: Karanbir catches
= 32 = 29 caught-only + 3 caught-and-bowled. Offered DISABLED with an explanatory tooltip
(kept VISIBLE so the owner's four kinds all show) rather than mapped to `catches` (would
mislead) or the bowling `wkt_caught_and_bowled` (different source, absent in batting mode).
A real c&b count needs a data-engineer `fielding_cte` column + metric def.

Independent verify: "Catches ≥ 10" leaderboard = **432** players == distinct
(batter_id, batter_name) with catches≥10 who batted in scope (the +1 vs raw distinct
batter_id = the documented name-variant quirk). In-app: Fielding Wicket Type → Caught adds
a "Catches ≥ 10" condition → 432 players; Caught/Run-out/Stumped enabled, Caught & bowled
disabled with note.

## TASK 3 — Restore 4 matchup-namespace filters (commit `wip(waveR2c-vsmetrics):`)
Coordinator-added. R2b's catch-all removal dropped 4 matchup-only filters. Restored by
EXPLICIT placement in `drawer.js` (each `leafMetric` resolves ONLY in its matchup namespace
— null/skipped in plain mode — so no plain-mode duplication):
- matchup_batting **Balls Faced** (KEY is `balls`, not `balls_faced` — the real reason line
  905's `leafMetric("balls_faced")` skipped it in Vs mode) + **Dismissals** (`dismissals`) →
  Batting · Basic Stats.
- matchup_bowling **Fours Conceded** (`fours_conceded`) + **Sixes Conceded** (`sixes_conceded`)
  → Bowling · Basic Stats.

In-app: after Vs=Spin (batting) both Balls Faced + Dismissals appear in Batting Basic; after
Vs=Right-handers (bowling) both Fours Conceded + Sixes Conceded appear in Bowling Basic.

## Both surfaces
Stats popup + Graph filters popup both render the shared drawer palette: Innings Number ▸
present, Fielding Wicket Type ▸ present, "Innings order" absent. Graph fetch (charts.js) uses
buildScopeClauses (teamCol batting_team/bowling_team) so the innings_number clause applies to
graphs too, both disciplines.

## Flags / concerns for the owner/orchestrator
1. **Matches column honesty (Innings Number).** buildQuery's `inningsLevel` gate (table.js,
   ~line 1055 — OUTSIDE serializeQueryState/conditionToHaving ownership) does NOT include the
   Innings Number filter, so the **MAT column reads the whole-scope player_matches count** while
   INNS/RUNS/etc. correctly reflect the innings subset (e.g. SA Yadav 1st-innings: MAT 64, INNS
   38). The old Innings-order filter DID make matches innings-level (it's a match-context join).
   Fix = add `inningsNumberFilterActive(state)` to that `inningsLevel` OR — a one-line owner/
   table-owner change. All other numbers are correct.
2. **Caught & bowled** has no fielding count (see Task 2) — disabled + flagged; needs a
   data-engineer fielding_cte column to become filterable.
3. **Dead plumbing retained** (within ownership limits): mc_innings_order (Innings order) and
   fld_kind (categorical dismissal-kind slice) are removed from the PALETTE only; their
   row/editor/pill/state remain inert. Full teardown touches non-owned files (pills.js,
   graph.js, filters.js buildMatchContextClauses, drawerInnings.js).
4. Two "Caught" labels now exist (Dismissal Type ▸ Caught = batter's dismissal `out_caught`;
   Fielding Wicket Type ▸ Caught = fielder's `catches`) — different groups, per spec, but worth
   an owner glance.
