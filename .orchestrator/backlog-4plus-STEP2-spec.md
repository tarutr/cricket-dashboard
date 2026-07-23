# "Full build" — STEP 2: implementation spec (for approval)

Re-derive the source DB's rich metrics into cricdb, STANDALONE (from raw `deliveries`/`wickets`/
`wicket_fielders`/`match_player_of_match` in `export_parquet.py`), wave by wave, each owner-approved.
Then #4 (preset dropdown) as a separate final job. Load/size/cleanup deferred to #12 + a later polish
pass (owner: "we'll clean all this up later"). Faithful to `reference/ingest.py`'s definitions.

## Verification spine (every wave)
1. **Re-derive independently** in the export from raw ball data (never reuse the app's own shape).
2. **Oracle cross-check:** compare our re-derived columns to the SOURCE's precomputed columns
   (`innings_batters`/`innings_bowlers`/`bowling_spells` in `data/cricket.duckdb`) — must match within
   rounding. This is the big win of re-deriving: own the logic AND validate against the owner's validated DB.
3. **Anchors held:** 2,813 / Karanbir 2,454 / SA Yadav 60·1,544·29.13·150.34 / Bumrah vs RHB 27·177·9 /
   SA Yadav vs Spin 38·454·SR140.99 — existing columns byte-identical (additive only).
4. `node --check`; local human-verify via the config-override (build parquet locally, point app at it).

## New columns by file (all additive)
**`batting_innings` + `matchup_batting`** (matchup = same, at its grain vs bowling_type):
`ones, twos, threes, fives, nb_fours, nb_sixes, non_boundary_runs` (INT counts) ·
`team_inns_balls` (INT; matchup: team balls vs that type) ·
`team_rel_sr, team_rel_dot_pct, team_rel_bpb, team_rel_nbsr` (FLOAT; per-innings differential batter−team;
matchup: batter-vs-type − team-vs-type).

**`bowling_innings` + `matchup_bowling`**:
`team_rel_econ, team_rel_pbe, team_rel_dot_pct, team_rel_sr` (FLOAT diff bowler−team) ·
`spell_count` (INT) · `open_spell_{balls,runs,wkts,dots}` · `close_spell_{balls,runs,wkts,dots}` (INT) ·
`longest_spell_balls` (INT) · `best_spell_wkts, best_spell_runs` (INT — for the best-spell peak).
(extras `wides_runs`/`noball_runs` already present.)

**`player_matches`** (already has match context): `catches, stumpings, run_outs` (INT), `player_of_match` (0/1).
Fielding rule: c&b counts as a catch; run-out credits ALL listed fielders; substitute catches EXCLUDED.

**`matches`**: `toss_winner, toss_decision, result_margin, result_margin_type, method, event_stage,
event_group, event_match_number, season, season_year_start, season_year_end`.

**NEW `bowling_spells.parquet`** (spell grain, super-overs excluded): identity (match_id, innings_number,
bowler_id, bowler_name, spell_number) + match context (match_type/gender/team_type/date/year) +
batting_team/bowling_team + first_over/last_over/balls/overs + runs_conceded/wickets/maidens/dots/fours/
sixes/wides_runs/noball_runs. Rates computed at query time.

## Metric formulas (component-based; rates divide at query time)
Batting: Fifties `SUM(runs BETWEEN 50 AND 99)` · Hundreds `SUM(runs>=100)` · Ducks `SUM(runs=0 AND
dismissed=1)` · Not Outs `SUM(dismissed=0)` · Running SR `SUM(non_boundary_runs)*100/NULLIF(SUM(balls_faced)
−SUM(fours_hit)−SUM(sixes_hit),0)` · %runs-from-boundaries `(4·SUM(fours_hit)+6·SUM(sixes_hit))*100/
NULLIF(SUM(runs),0)` · %in 1s/2s/3s · Balls per four/six · Balls-faced share `SUM(balls_faced)*100/
NULLIF(SUM(team_inns_balls),0)` · **Net Relative SR/Dot%/BpB/RunningSR = `SUM(team_rel_*)`** (kind:total,
named "Net Relative … (vs team)").
Bowling: 4-fers `SUM(wickets=4)` · 5-fers `SUM(wickets>=5)` · Extras `SUM(wides_runs+noball_runs)` +
per-over · Overs (display of `SUM(balls)`) · **Net Relative Econ/SR/Dot% = `SUM(team_rel_*)`** · Spells/inns
`SUM(spell_count)*1.0/COUNT(*)` · Best spell (peak by wkts then −runs) · Opening/Closing-spell Econ/SR/Dot%
(from open_/close_ components).
Fielding/Impact (joined by player_id): Catches `SUM(catches)` · Stumpings · Run-outs · MoM `SUM(player_of_match)`.
Matchup: composition rates + Net-Relative computed at matchup grain (vs pace/spin; vs hand/position).

## Novel export logic (the hard bits — data-engineer, Opus/xhigh, test-first)
- **Team-relative:** per innings, one team aggregate (`GROUP BY match,innings`, whole side incl. the player)
  → each player's differential; store per row; leaderboard `SUM`s it. Matchup adds `bowling_type`/hand to
  the group key (team-vs-type). Window-relative NOT built (dropped — flawed).
- **Spells:** replicate `identify_spells` (gap ≥3 over-numbers = new spell) set-based; derive spell_count,
  first/last spell components, longest/best; also emit the spell-grain rows for `bowling_spells.parquet`.
- **Fielding:** aggregate `wicket_fielders`⋈`wickets` per (match, player) — catch (caught + c&b),
  stumping (stumped), run-out (run out, all listed fielders), exclude `substitute` — onto player_matches.

## Spell-records view (new event-grain surface)
A new view where each row is ONE spell (not a player aggregate): rank/filter individual spells by figures /
economy / phase / scope / player, off `bowling_spells.parquet`. Frontend-heavy (Opus) — it's a novel
surface; exact placement (own tab vs a mode in Stats) refined with owner during the wave.

## Waves (sequential; each = export + metrics + wiring + LOCAL verify + owner sign-off)
| W | Scope | Files touched | Sub-agent(s) |
|---|---|---|---|
| 0 | **Counting metrics** (50s/100s/ducks/NO, 4w/5w, Overs) — 🟢 no export | metrics.js, state.js | data-engineer (Opus/xhigh) — formulas are numbers-critical |
| 1 | **Batting composition** (plain + matchup) | export_parquet.py, metrics.js | data-engineer (Opus/xhigh) |
| 2 | **Team-relative** (bat+bowl, plain + matchup) — the novel per-innings differential | export_parquet.py, metrics.js | data-engineer (Opus/xhigh) |
| 3 | **Fielding + Impact** (player_matches + join) | export_parquet.py, table.js (join), metrics.js, drawer/filters UI | data-engineer (join+export) + frontend-engineer (condition/column sub-group) |
| 4 | **Bowling spells — aggregate metrics** (on bowling_innings) | export_parquet.py, metrics.js | data-engineer (Opus/xhigh) |
| 5 | **Per-spell records view** (new bowling_spells.parquet + event-grain view) | export_parquet.py, config.js, db.js, new view module | data-engineer (export) + frontend-heavy (Opus/xhigh, the view) |
| 6 | **Match-context fields + filters** (knockout/toss/result/method) | export_parquet.py, matches wiring, filters.js | data-engineer (export) + frontend-engineer (filter UI) |

Order rationale: 0 first (instant, zero-pipeline, proves the metric path); 1→2 build the batting depth
(2 reuses 1's grain work); 3 introduces the player_id join; 4→5 spells (aggregate then the records view);
6 last (self-contained). Sequential = no two agents in export_parquet.py at once.

## End game
All waves on the branch, each human-verified locally. Then: integrated fresh-eyes review (Opus data-engineer)
+ orchestrator anchor repro → owner approval → **staged push** (data commits → pipeline run → verify all new
columns live on R2 → UI commits) → then the #4 preset-dropdown work as its own gated effort.
