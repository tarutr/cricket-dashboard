# "Full build" — Step 1: data + dashboard PLAN (for approval)

The program: bring the source DB's richness into the app, then (separate, later) restructure the column
presets (#4). This doc is the SHAPE + APPROACH for the data + dashboard work. The detailed wave-by-wave
spec with sub-agent roles is Step 2 (next gate). Load-time is backlog #12 (deferred, owner-accepted).

## Locked decisions (owner, this session)
- Full scope: score-composition/rotation · net-relative (team & window) · fielding · impact (MoM + match
  context) · bowling spells.
- **Source = export the source's already-computed columns** by joining `innings_batters`/`innings_bowlers`
  into the export on the innings key — with these rules:
  - **Counts** (catches, ones, non-boundary runs…) → export & `SUM()`.
  - **Rates** (running SR, bp4…) → export the INGREDIENT counts, divide at query time (never store a
    pre-divided per-innings rate — can't average averages).
  - **Net-relative** → export the per-innings differential, `SUM()` it (pure addition), name it "Net …".
  - **Fielding + MoM** → aggregate to per-player-per-match, add columns to the existing `player_matches`
    file (NOT a new file); join into batting/bowling views by `player_id`.
- **Fielding is not a discipline** — it surfaces as a "Fielding" sub-group in the "+ Add condition…" list
  (usable as filter + column) in BOTH batting and bowling views.
- Matchup mode is OUT of scope for this program (its parquets don't carry these columns) unless owner asks.

## Verification honesty (a real tradeoff of "export computed columns")
Existing anchors (2,813 / Karanbir 2,454 / SA Yadav / matchup) come from `export_parquet.py`'s OWN
aggregation and stay recomputed + verified byte-identical. The NEW columns are COPIED from the source's
precomputed tables, so we can't re-derive-and-diff them the way we did #3. Instead: (a) verify the copy is
faithful (row-set alignment on the join key — the export includes 0-ball crease appearances that
`innings_batters` may not, so LEFT JOIN, NULLs OK), (b) independent spot-checks of a few players against a
hand recomputation, (c) trust the source's months-validated computation (the reference doc is authoritative
for calc rules). This is the accepted cost of not re-deriving.

## The waves (vertical slices — each = export cols + metric defs + dashboard wiring + LOCAL verify)
| # | Family | New data | Example new metrics | Pipeline? |
|---|---|---|---|---|
| 1 | **Counting metrics** | none (over existing cols) | Batting: **50s, 100s, Ducks, Not Outs**; Bowling: **4-fers, 5-fers**; **Overs** (=balls/6 display) | 🟢 none |
| 2 | **Batting composition / rotation** | onto `batting_innings`: ones, twos, threes, non_boundary_fours, non_boundary_sixes, fives, non_boundary_runs | **% runs from boundaries**, **Running (non-boundary) SR**, % runs in 1s/2s/3s, **Balls per four / six** | 🟡 |
| 3 | **Net relative** | onto `batting_innings`: **team_relative_* only** (sr, dot_pct, bpb, non_boundary_sr); onto `bowling_innings`: team_relative_* (economy, per_ball_econ, dot_pct, sr) | **Net Relative SR/Dot%/BpB/Running-SR (vs team)**, Net Relative Economy/SR/Dot% (bowl) — all `SUM`, named "Net" | 🟡 |
| 4 | **Fielding + Impact** | onto `player_matches`: catches, stumpings, run_outs, player_of_match | **Catches, Stumpings, Run-outs, Player-of-Match count** — joined by player_id, shown in both views under "Fielding"/"Impact" | 🟡 + query join |
| 5 | **Bowling spells + extras** | onto `bowling_innings`: spell_count (+ first_over/last_over) | **Spells per innings**, avg entry over; **Extras conceded / per over** (wides+no-balls already stored) | 🟡 (light) |
| 6 | **Match-context filters** *(optional)* | onto `matches`: event_stage, toss_decision, result_type/margin_type, method | Filters: **Knockout stage**, Toss, Result/D-L (not leaderboard metrics) | 🟡 |

Deep spell-level analysis (new-ball vs death SPELL economy) needs the `bowling_spells` grain (a separate
rollup) — deferred as optional beyond Wave 5 unless owner wants it in.

## Dashboard wiring (common to every wave)
- Each new metric = a `metrics.js` def: sqlExpression over the new column(s), `discipline`, format flags
  (`isPhaseMetric`/red-ball suitability), `kind` (total/rate/percent) — net-relative are `kind:total` (SUM).
- New metrics flow through the EXISTING registries into: leaderboard columns + picker, the "+ Add condition…"
  list, the Graph Builder metric lists, and the player popup — no new plumbing per surface.
- **Fielding/Impact** are the one structural change: a subquery joined by `player_id` over the same scope,
  surfaced as "Fielding"/"Impact" condition sub-groups. Numbers-critical join → data-engineer, test-first.
- Rates that need a team denominator (e.g. balls-faced share) get their INGREDIENT exported too, or are
  deferred — decided per-metric in Step 2.

## Deploy / verification model (matches #3)
- Everything built on the branch. Each wave verified LOCALLY: build the parquet from `data/cricket.duckdb`,
  point the app at it via the temp config override, human-verify, revert override. Nothing on R2 mid-program.
- End: integrated review of the whole diff → owner approval → **staged push** (data commits → pipeline run →
  confirm columns live on R2 → UI commits) → then the #4 preset work.

## Resolved design calls (owner, this session)
- **Window-relative DROPPED** (self-inclusion bias + partner-luck + position bias + heaviest SQL — a genuine
  flaw in the upstream stat). **Team-relative kept** (clean: one per-innings group-by, mild consistent
  self-inclusion, exposed to freak tiny-innings in the net — accepted).
- **Fielding definitional calls:** caught-and-bowled COUNTS as the bowler's fielding catch · run-outs credit
  ALL listed fielders · substitute-fielder catches are EXCLUDED from a player's record.

## Scope finalised (owner, this session)
1. **Matchup mode: IN this round.** Add the composition RATES at matchup grain to `matchup_batting`
   (+ counts: ones/twos/threes, non-boundary 4s/6s, non_boundary_runs) → running SR / boundary% / dot% /
   balls-per-4/6 **vs pace/spin**; matchup_bowling gets the conceded equivalents. Grows the 2 largest files
   (accepted — #12 handles load).
2. **Spells: FULL.** (a) player-aggregate spell metrics folded into `bowling_innings` (spells/innings, avg &
   longest spell, best spell [peak], opening- vs closing-spell econ/SR/dot% via components); AND (b) a
   **spell-grain export `bowling_spells.parquet`** powering a **per-spell RECORDS leaderboard** (rank/filter
   individual spells — best figures, most economical — by scope/player/phase). Per-spell records ARE a
   leaderboard feature (owner).
3. **Match-context: ALL** context fields onto `matches` (toss, result margin/type, method/D-L, event
   stage/group/match-number, season) — powers filters now + match scorecards later (last backlog item).
4. **Genuinely NOT matchup** (no dimension exists — not a deferral): fielding (a catch isn't "vs spin"),
   spells (a spell isn't vs a batter type), innings-total counts (50s/100s). These stay player/innings level.
5. **One open call:** matchup **team-relative** ("did he handle spin better than his own team did") — coherent
   but heavy (needs team-vs-type aggregates + more columns on the biggest files). Owner to decide.
