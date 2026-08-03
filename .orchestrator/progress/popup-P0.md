# Player pop-up rebuild on the ball engine — P0 report (Map · Anchor · Design)

> P0 = MEASUREMENT + DESIGN ONLY. No `src/` touched, no production code. This note
> is the owner sign-off gate for the whole program (`.orchestrator/popup-ballengine-plan.md`).
> Nothing past P0 builds without the owner signing this off.

## Method + provenance (decision-39 independence)

- Anchors derived by HAND SQL (DuckDB CLI v1.5.1) against the pop-up's CURRENT
  sources — `batting_innings` / `bowling_innings` / `matchup_batting` /
  `matchup_bowling` / `fielding_events` parquets in `data/wave1_out/` — matching
  each section's exact query shape, NEVER by running the app's own aggregation.
- `data/wave1_out/` is the correct dataset: it reproduces the standing batting
  anchor byte-exact (60 inns / 1,544 runs / 29.13 avg / 150.34 SR).
- Ball-layer reproduction proven INDEPENDENTLY from raw balls
  (`data/step0/v1/deliveries_m_t20.parquet` + `player_profiles.parquet`) via
  hand-written two-level aggregation: batting headline = 60 / 1,544 / 53 diss /
  29.13 / 150.34 / HS 100, and vs-Spin = 38 inns / 322 balls / 454 runs / SR
  140.99 — both EXACT. This confirms the ball layer carries what the pop-up needs.
- Anchor scope throughout: SA Yadav (`batter_id`/`bowler_id`/`fielder_id` =
  `271f83cd`), Men implied by id, **T20 bucket** = `match_type IN ('T20','IT20')`,
  **International** = `team_type='international'`, **dates day-bounded**
  `match_date >= DATE '2023-07-01' AND match_date < DATE '2026-07-03'`
  (2026-07-02 inclusive via next-calendar-day). Super overs excluded (baked into
  the parquets; enforced in the base CTE for the ball layer).

---

# Deliverable 1 — Section inventory (every section the pop-up computes today)

Pop-up = an identity header (profile, not a stat) + a sticky **Batting | Bowling**
toggle, each rendering a tight grid. Page scope is **Format + Date + Team type
only** (gender inert — a `player_id` pins gender; every leaderboard/drawer filter
is inert). On top sits the pop-up's OWN 4-dim overlay mini-engine
(date / positions / opposition / vs — `playerData.js` `applyOverlay` +
`PLAYER_SECTION_SUPPORT`), which the rebuild REPLACES.

Every section reads the SAME views the leaderboard uses (`FROM batting` /
`bowling` / `matchup_batting` / `matchup_bowling`), scoped by
`pageScopeClauses(state) AND <idCol> = '<player>'`. Metric SQL comes ONLY from
`metrics.js` (`selectList` interpolates each `sqlExpression`).

### Batting tab (`battingGridHTML`)

| # | Section | What it shows | Source / fetch | Grouping | Aggregation (metric keys) |
|---|---|---|---|---|---|
| B1 | **Hero stat cards** (5 tiles) | Inns · Runs · Avg · SR¹ · HS | `fetchBattingCore` → `FROM batting`, **no GROUP BY** | one row | `innings`=`COUNT(*)`, `runs`=`SUM(runs)`, `average`, `strike_rate` (¹`balls_per_dismissal` swapped in for Red-Ball-only scope), `high_score`=`MAX(runs)` |
| B2 | **Wicket Type** (how-out fingerprint) | Bars per dismissal kind + "Not out: N of M innings" | same `fetchBattingCore` row | one row | `SUM(dismissed)` + per-kind `SUM(CASE WHEN dismissal_kind='…')` over the **12** `DISMISSAL_KINDS`; Not out = `innings − dismissals` |
| B3 | **Progressive Scoring** (3 tiles) | SR balls 1–10 / 11–20 / 21+ | same `fetchBattingCore` row | one row | `sr_first10`,`sr_11_20`,`sr_21plus` (`SUM(fbX_runs)*100/NULLIF(SUM(fbX_balls),0)`) |
| B4 | **By batting position** (mini-table) | Pos · Inns · Runs · Avg · SR | `fetchBattingPositions` → `FROM batting` | `GROUP BY batting_position ORDER BY batting_position` | `innings,runs,average,strike_rate` per position |
| B5 | **Vs opposition** (mini-table, uncapped) | Team · Inns · Runs · Avg · SR | `fetchBattingOpposition` → `FROM batting` | `GROUP BY bowling_team ORDER BY runs DESC, team` | `innings,runs,average,strike_rate` per opponent |
| B6 | **Matchups** | Coverage line + "Vs pace and spin" (coarse, incl Uncategorised, +%BF) + "Vs bowling type" (fine, Pace/Spin grouped) | `fetchBattingMatchups` → `FROM matchup_batting` (**3 queries**: coverage, coarse, fine) | coverage: none; coarse: `GROUP BY bowling_group`; fine: `GROUP BY bowling_type` (excl `(unmapped)`), both `ORDER BY balls DESC` | `innings`(=`COUNT(DISTINCT match:inn`)`), `balls`, `runs`, `strike_rate`, `average`, `dismissals`; %BF derived in JS = bucket balls ÷ coverage total |

`fetchBattingCore` also has a **`vs`-scoped composite** path (`fetchBattingCoreVs`
→ `matchup_batting`): when the overlay's `vs` bucket is active, B1/B2 recompute
from `matchup_batting` (HS tile → Boundary %; a coverage line appears) and
B3/B4/B5 are hidden (can't split by style). This whole `vs`-overlay path is part
of the mini-engine the rebuild retires.

### Bowling tab (`bowlingGridHTML`)

| # | Section | What it shows | Source / fetch | Grouping | Aggregation (metric keys) |
|---|---|---|---|---|---|
| W1 | **Hero stat cards** (6 tiles) | Inns · Wkts · Avg · Econ · SR · BBI | `fetchBowlingCore` → `FROM bowling`, **no GROUP BY** | one row | `innings,wickets,average,economy,strike_rate,best` (BBI=`arg_max("W-R", wickets*1000-runs)`) |
| W2 | **Wicket types** (bars) | Bowled/LBW/Caught/c&b/Stumped/Hit-wkt | same `fetchBowlingCore` row | one row | `wkt_bowled,wkt_lbw,wkt_caught,wkt_caught_and_bowled,wkt_stumped,wkt_hit_wicket` (= `SUM(wickets_<kind>)`) |
| W3 | **Vs opposition** (mini-table, uncapped) | Team · Inns · Wkts · Avg · Econ | `fetchBowlingOpposition` → `FROM bowling` | `GROUP BY batting_team ORDER BY wickets DESC, team` | `innings,wickets,average,economy` per opponent |
| W4 | **Matchups** | Coverage line + hands table (RHB/LHB/Uncategorised, +%balls) | `fetchBowlingMatchups` → `FROM matchup_bowling` (**2 queries**: coverage, hands) | `GROUP BY batting_hand ORDER BY balls DESC` | `innings,balls,runs_conceded,wickets,economy,average,strike_rate`; %balls derived in JS |

**Not a section but computed:** identity header (`fetchProfile`), player gender
(`fetchPlayerGender`, inert), in-pop-up search (`searchPlayers`), and the overlay
drawer's own option loaders (`fetchOppositionOptions`, `fetchVsTypeOptions`).

**No fielding section exists today** (grep of all four pop-up files: 0 references
to fielding/fielder/catches/stumpings). Fielding metrics live in `metrics.js`
(`catches`, `caught_and_bowled`, `stumpings`, `run_outs`, `dismissals_effected`,
`player_of_match`) but are leaderboard-only. → P3 is genuinely NEW (see D3).

---

# Deliverable 2 — Per-section anchors (SA Yadav, standard anchor scope)

**These are the byte-identical targets the rebuild must reproduce.** All derived
independently (hand SQL, current sources).

### B1 — Batting hero cards
`Inns 60 · Runs 1,544 · Avg 29.13 · SR 150.34 · HS 100`
(supporting: dismissals 53, balls faced 1,027)

### B2 — Wicket Type (how-out), of 53 dismissals; Not out 7 of 60
`Caught 43 · LBW 4 · Stumped 3 · Bowled 1 · Run Out 1 · Caught & Bowled 1`
(Hit Wicket 0, Retired Out 0, Obstructing 0, Handled 0, Timed Out 0, Hit Twice 0)
Sum = 53. ✓

### B3 — Progressive Scoring
`SR 1–10 = 133.19 (634/476) · SR 11–20 = 148.79 (369/248) · SR 21+ = 178.55 (541/303)`

### B4 — By batting position (Pos · Inns · Runs · Avg · SR)
```
3   22   551   29.00   153.06
4   34   967   32.23   150.39
5    4    26    6.50   108.33
```
Σ inns 60 / Σ runs 1,544. ✓

### B5 — Vs opposition (Team · Inns · Runs · Avg · SR; ORDER BY runs DESC, team) — 14 teams
```
Australia                 10  259  28.78  167.10
New Zealand                6  242  60.50  195.16
South Africa              11  237  21.55  130.94
West Indies                5  184  36.80  142.64
United States of America   2  134   NULL  136.73   (0 dismissals → Avg NULL, correct)
Bangladesh                 5  123  24.60  170.83
Sri Lanka                  4  104  26.00  173.33
Pakistan                   5   87  21.75  106.10
England                    7   86  12.29  130.30
Netherlands                1   34  34.00  121.43
Zimbabwe                   1   33  33.00  253.85
Namibia                    1   12  12.00   92.31
United Arab Emirates       1    7   NULL  350.00   (0 dismissals → Avg NULL)
Ireland                    1    2   2.00    50.00
```
Σ runs 1,544. ✓ (NULL avg via NULLIF is the required div-by-zero guard.)

### B6 — Batting Matchups
Coverage: **913 of 1,027 balls faced** carry a mapped style (88.9%).
Coarse (bowling_group, incl Uncategorised; Inns·Balls·Runs·SR·Avg·Out·%BF):
```
Pace          56  591  913  154.48  21.74  42   57.5%
Spin          38  322  454  140.99  64.86   7   31.4%   ← standing anchor
Uncategorised 11  114  177  155.26  59.00   3   11.1%
```
Fine (bowling_type, excl Uncategorised; ORDER BY balls DESC):
```
Fast-medium             38  265  465  175.47  24.47  19
Fast                    30  154  206  133.77  14.71  14
Off-spin                20  112  165  147.32 165.00   1
Slow left-arm orthodox  17   97  134  138.14  44.67   3
Leg-spin                20   93  129  138.71  64.50   2
Medium                  17   87  115  132.18  38.33   3
Medium-fast             14   85  127  149.41  21.17   6
Left-arm wrist-spin      2   20   26  130.00  26.00   1
```

### W1 — Bowling hero cards (SA Yadav bowled 1 over in scope)
`Inns 1 · Wkts 2 · Avg 2.50 · Econ 5.00 · SR 3.00 · BBI 2-5`
(balls 6, runs conceded 5)

### W2 — Bowling wicket types
`Caught 2` (Bowled 0, LBW 0, c&b 0, Stumped 0, Hit Wkt 0). Σ = 2. ✓

### W3 — Bowling Vs opposition
`Sri Lanka · Inns 1 · Wkts 2 · Avg 2.50 · Econ 5.00`

### W4 — Bowling Matchups (batting_hand)
Coverage: 6 of 6 balls mapped (men's international → both batters have profiles).
```
Left-handers   1  4  4  1wkt  Econ 6.00
Right-handers  1  2  1  1wkt  Econ 3.00
```

### Fielding (NOT a section today — target for P3)
SA Yadav as fielder in scope, substitutes excluded:
`Catches 24 · Stumpings 0 · Run-outs 4 · Dismissals effected 28` (c&b folded into catches per the fielding_cte rule).

---

# Deliverable 3 — Ball-engine query design (per section)

**Central fact:** the pop-up's queries ALREADY read `FROM batting` / `bowling` /
`matchup_batting` / `matchup_bowling`. With `?engine=ball` on, `db.js`
transparently re-points those four views at ball reconstructions
(`ballEngine.js` / `ballEngineMatchup.js`), proven cell-for-cell identical to the
retired parquets (Wave 1 oracle: 0 mismatches). So **the pop-up already computes
from balls, byte-identical, today** — the P1/P2/P3 work is (a) making the ball
layer the pop-up's declared single source, (b) replacing the 4-dim overlay
mini-engine with the full palette (scope + Team + matchup + Ball Ranges +
per-innings slices), and (c) adding fielding.

### How each section maps to the ball reconstruction

Every batting section reads the reconstructed `batting` view; `db.js`
`playerScopeFor` pushes a **single-player base predicate** into the delivery CTE
(`batter_id = X OR non_striker_id = X OR player_out_id = X OR
wickets_extra…player_out_id = X`) so ONLY SA Yadav's innings rebuild. Column
pruning (`neededViewColumns`) emits only the aggregates each query names.

| Section | Ball-engine reproduction | Carries it? |
|---|---|---|
| B1 hero | `batting` recon → `runs`,`balls_faced`,`dismissed`,`dismissal_kind`; two-level (ball → per-innings via `crease` union + `bat`/`dis` CTEs → player). HS=`MAX(runs)` over innings rows. | ✅ proven from raw balls (60/1,544/53/29.13/150.34/100) |
| B2 how-out | `dis` CTE emits `dismissal_kind` (flat `wicket_kind` + `wickets_extra` overflow, MIN tie-break). Run-out included; retired-hurt/not-out excluded. | ✅ (dismissal set incl. `wickets_extra` recovers the 16 lost 2nd-wicket dismissals) |
| B3 progression | `bat` CTE `fb1_10/fb11_20/fb21p` runs+balls from `bat_ball` clock (faced-ball ordinal). | ✅ (`bat_ball` stored on ball rows) |
| B4 positions | same `batting` recon, `GROUP BY batting_position` on the per-innings rows; `posx` CTE supplies `batting_position`. | ✅ |
| B5 opposition | same recon, `GROUP BY bowling_team` (denormalised on ball rows via `ictx`). | ✅ |
| B6 batting matchups | `matchup_batting` recon = balls LEFT JOIN `profiles` on `bowler_id`, key `bowling_type`/`bowling_group`; `GROUP BY match,inn,batter,bowling_type` → player. Coverage = `SUM(balls_faced)` all vs mapped. | ✅ proven from raw balls (vs-Spin 38/322/454/140.99) |
| W1 hero | `bowling` recon: `bagg` grain, `balls`/`runs_conceded`(=`runs_batter+noballs+wides`)/`wickets`(=`SUM(bowler_credited_wkts)`); BBI via `arg_max`. | ✅ |
| W2 wicket types | `wkk` CTE: `SUM(kindct(kind))` over flat + `wickets_extra`. | ✅ (recovers 1 lost 2nd-wicket bowler credit) |
| W3 bowling opposition | `GROUP BY batting_team` on `bagg` rows. | ✅ |
| W4 bowling matchups | `matchup_bowling` recon = balls LEFT JOIN `profiles` on `batter_id`, key `batting_hand` + striker `batting_position`. | ✅ |

All ten sections use **player-LOCAL columns only** (no `team_inns_balls`, no
`team_rel_*`, no `balls_faced_share`), so the fast player-scoped reconstruction is
byte-identical for every one (`columnsArePlayerLocal` = true). **No pop-up section
forces the slower whole-innings rebuild.**

### 🚩 FLAG — the one section the ball layer CANNOT reproduce: FIELDING (new, P3)

The delivery ("ball layer") rows do **not** carry fielder attribution. A ball has
`bowler_credited_wkts`, `wicket_kind`, `player_out_id`, `wickets_extra` — but NOT
who took the catch / effected the run-out. Fielder identity lives ONLY in the
separate `fielding_events.parquet` (grain: one row per wicket-credit;
`fielder_id`, `fielder_index`, `kind`, `substitute`, plus `out_batting_position`,
`out_hand`, `phase`, full match context). Per `ball-layer-design.md`,
`fielding_events` **STAYS in the browser** at cutover precisely because
multi-fielder credits don't fit one-row-per-ball.

So a pop-up **Fielding section (P3) must read `fielding_events` directly**, NOT the
ball layer. What it needs:
- A per-fielder aggregation `WHERE fielder_id = X AND substitute IS NOT TRUE`
  under the same core scope (fielding_events carries `match_type`/`team_type`/
  `match_date`), mirroring `metrics.js`'s existing `fielding_cte` shape:
  `catches` (`caught`+`caught and bowled`), `stumpings`, `run_outs`,
  `dismissals_effected` (sum of the three), plus distinct `caught_and_bowled`.
- Owner-approved section content: the plan names **"Fielding Wicket Type ▸" +
  Wickets by Batting Position** — both derivable from `fielding_events`'s `kind`,
  `out_batting_position`, `out_hand`, `phase`. Anchor already computed: SA Yadav
  = 24 catches / 0 stumpings / 4 run-outs / 28 effected.
- No numbers-sacred risk to existing sections (additive new source). Independent
  verify against `fielding_events` in P3.

### Ball-Ranges / phase / over-range / player-clock filters (P2)

Already fully supported by `deliveryWindow.js` for all four namespaces
(`batting`/`bowling`/`matchup_batting`/`matchup_bowling`): phase → `phase IN(…)`,
overs → `over_number BETWEEN from-1 AND to-1`, balls → `team_ball BETWEEN…`,
first/last-N → `bat_ball`/`bat_ball_rev`/`bowl_ball`/`bowl_ball_rev`. `db.js`
pushes the active window as `windowPredicate` into the base ball CTE (the
deliberate row-set exception). P2 just needs to wire the pop-up's palette entries
to `state.deliveryWindow`; the engine plumbing exists.

---

# Deliverable 4 — Per-innings numeric-slice classification (DRAFT for owner sign-off)

**This is a DRAFT. I am NOT making the product decision (Rule 3).** One genuine
ambiguity in the plan's own examples needs an owner ruling — see the callout.

**Test applied (the strict, defensible principle):** a metric is a valid
**SLICE** iff it is a property EACH INNINGS individually possesses that is
well-defined and finite for one innings in isolation — so the pop-up can filter
the player's innings by it (`WHERE <per-innings value> OP N`) and re-aggregate the
survivors. It is **NOT** a slice if it is a cross-innings aggregate/ratio/peak/
count (needs multiple innings), or a rate whose per-innings denominator is
routinely 0 (undefined per innings).

### 🚩 OWNER DECISION REQUIRED — per-innings RATES (Economy vs Strike Rate)

The plan's illustrative examples are internally inconsistent: batting **Strike
Rate = SLICE** but **Economy = NOT** — yet they are structurally identical
per-innings ratios (runs÷balls). Under the strict principle, ALL per-innings-
defined rates whose denominator is the innings' own ball count (Strike Rate,
Economy, Dot %, Boundary %, Boundary % Conceded, Running SR, % Runs in Xs) are
SLICES: every real innings has balls>0, so each is defined and finite.

Two coherent readings — the ball engine implements EITHER; the choice is yours:
- **(A) Strict / inclusive:** every per-innings-defined rate is a slice (SR AND
  Economy AND Dot%/Boundary%/… all sliceable). Internally consistent.
- **(B) Narrow:** only per-innings **additive totals** (runs, balls, 4s, 6s,
  dots, wickets, …) **plus batting Strike Rate** are slices; ALL other rates
  (Economy, Dot%, Boundary%, …) are NOT. Matches the plan's literal examples but
  treats SR and Economy differently for no structural reason.

**The tables below use reading (A) and mark every rate flagged `⚖` where (A) and
(B) diverge.** If you pick (B), flip every `⚖ SLICE` to NOT.

### Batting namespace

| Metric (key) | SLICE? | Reason if NOT (or ⚖) |
|---|---|---|
| Runs (`runs`) | **SLICE** | — additive per-innings total |
| Balls Faced (`balls_faced`) | **SLICE** | — |
| Fours (`fours`) | **SLICE** | — |
| Sixes (`sixes`) | **SLICE** | — |
| Dots — as count | **SLICE** | — (per-innings dot count) |
| Strike Rate (`strike_rate`) | **SLICE** | — per-innings ratio, balls>0 (owner-named) |
| Dot Ball % (`dot_pct`) | **⚖ SLICE** | per-innings ratio; NOT under reading (B) |
| Boundary % (`boundary_pct`) | **⚖ SLICE** | per-innings ratio; NOT under (B) |
| % Runs from Boundaries (`boundary_runs_pct`) | **⚖ SLICE** | per-innings ratio; NOT under (B) |
| % Runs in 1s/2s/3s/4s/5s/6s (`runs_*_pct`) | **⚖ SLICE** | per-innings ratios; NOT under (B) |
| Running Strike Rate (`running_sr`) | **⚖ SLICE** | per-innings ratio; NOT under (B) |
| Batting Average (`average`) | **NOT** | ÷ dismissals; a single innings has 0 or 1 dismissal → degenerate/undefined |
| Balls per Dismissal (`balls_per_dismissal`) | **NOT** | ÷ dismissals — same as Average |
| Balls per Boundary (`balls_per_boundary`) | **NOT** | ÷ (4s+6s); 0 boundaries in many innings → undefined |
| Balls per Four (`balls_per_four`) | **NOT** | ÷ fours; 0 fours common → undefined |
| Balls per Six (`balls_per_six`) | **NOT** | ÷ sixes; 0 sixes common → undefined |
| High Score (`high_score`) | **NOT** | peak = `MAX(runs)` across innings (maps to the Runs slice `runs ≥ N`) |
| Not Out % (`not_out_pct`) | **NOT** | share across innings; per innings it's just the 0/1 dismissed flag |
| Not Outs (`not_outs`) | **NOT** | count of innings meeting a condition (career aggregate) |
| Ducks (`ducks`) | **NOT** | count of innings (career aggregate); maps to `runs=0 AND out` slice |
| Fifties (`fifties`) | **NOT** | count of innings 50–99 (career aggregate); maps to a Runs range slice |
| Hundreds (`hundreds`) | **NOT** | count of innings ≥100 (career aggregate); maps to `runs ≥ 100` |
| Innings Score ≥ N (`innings_score_ge`) | **NOT** (metric) | it IS a count of qualifying innings; but its threshold IS exactly the Runs slice — offer as the Runs slice, not this counter |
| Matches (`matches`) | **NOT** | `COUNT(DISTINCT match_id)` — cross-match aggregate, not a per-innings quantity |
| Innings (`innings`) | **NOT** | the innings COUNT itself — you can't slice innings by innings-count |
| Balls-Faced Share (`balls_faced_share`) | **NOT** | needs the whole team innings' balls (whole-innings, not player-local) |
| R. Pos. (`r_pos`) | **NOT** | modal position over the whole career scope; a display label |
| SR first-10 / 11-20 / 21+ (`sr_first10`,`sr_11_20`,`sr_21plus`) | **NOT** | replaced by the delivery-window player-clock (first/last-N faced) — window slices this structurally |
| Phase SRs (`pp_/mid_/death_strike_rate`, `odi_*`) | **NOT** | phase-aggregate rates replaced by the delivery-window phase/over filter (decision 67 retires per-phase filters) |
| Dismissal-kind counts + `_pct` (`out_caught`…) | **NOT** | career aggregates; the per-innings analog is the categorical "how out this innings", not a numeric slice |
| Fielding (`catches`,`stumpings`,`run_outs`,`dismissals_effected`,`caught_and_bowled`) | **NOT** | not a batting per-innings quantity — separate fielding source (P3) |
| Player of the Match / PotM Count (`player_of_match`,`potm_count`) | **NOT** | per-MATCH award count, not a per-innings quantity |

### Bowling namespace

| Metric (key) | SLICE? | Reason if NOT (or ⚖) |
|---|---|---|
| Wickets (`wickets`) | **SLICE** | additive per-innings total |
| Balls Bowled (`balls`) | **SLICE** | — |
| Runs Conceded (`runs_conceded`) | **SLICE** | — |
| Dots — as count (`dots`) | **SLICE** | — |
| Fours Conceded (`fours_conceded`) | **SLICE** | — |
| Sixes Conceded (`sixes_conceded`) | **SLICE** | — |
| Maidens (`maidens`) | **SLICE** | per-innings count of maiden overs |
| Wides / No-balls (`extras_wides`,`extras_noballs`) | **SLICE** | per-innings run totals |
| Wicket-kind counts (`wkt_bowled`…`wkt_hit_wicket`) | **SLICE** | per-innings counts |
| Economy (`economy`) | **⚖ SLICE** | per-innings ratio runs÷overs, balls>0 — **structural mirror of batting SR**; plan example says NOT (reading B). **← the decision above resolves this** |
| Dot Ball % (`dot_pct`) | **⚖ SLICE** | per-innings ratio; NOT under (B) |
| Boundary % Conceded (`boundary_pct_conceded`) | **⚖ SLICE** | per-innings ratio; NOT under (B) |
| % Runs from Boundaries (`boundary_runs_pct`) | **⚖ SLICE** | per-innings ratio; NOT under (B) |
| Bowling Average (`average`) | **NOT** | ÷ wickets; 0-wicket innings common → undefined |
| Bowling Strike Rate (`strike_rate`) | **NOT** | ÷ wickets; 0-wicket innings → undefined |
| Wickets per Innings (`wickets_per_innings`) | **NOT** | ÷ innings count — cross-innings aggregate (per innings it's just Wickets) |
| Overs (`overs`) | **SLICE** (display of Balls) | same stored value as `balls` (a per-innings total) shown as O.B — sliceable via Balls |
| Best Bowling / BBI (`best`) | **NOT** | peak across innings (maps to a "≥W wkts for ≤R runs" per-innings condition) |
| Four/Five-Wicket Hauls (`four_wicket_hauls`,`five_wicket_hauls`) | **NOT** | counts of qualifying innings (career aggregate); map to a Wickets slice |
| Wicket Hauls ≥ N (`wicket_hauls_ge`) | **NOT** (metric) | counter of qualifying innings; its threshold IS the Wickets slice — offer as Wickets |
| Matches (`matches`) / Innings (`innings`) | **NOT** | cross-match / the innings count itself |
| Phase econ/wkts (`pp_/mid_/death_*`, `odi_*`) | **NOT** | replaced by the delivery-window phase/over filter (decision 67) |
| Fielding + Impact (as batting) | **NOT** | separate source / per-match, not per-innings bowling quantities |

**Summary count (reading A):** SLICE = per-innings additive totals (batting:
runs, balls, 4s, 6s, dots; bowling: wickets, balls, runs conceded, dots, 4s/6s
conceded, maidens, wides, no-balls, wicket-kind counts, overs) **plus** every
per-innings-defined rate (SR/Economy/Dot%/Boundary%/Running SR/%Runs-in-Xs).
Everything else (averages, ÷-by-possibly-0 ratios, peaks, cross-innings counts,
phase/faced-ball rates now handled by the window, fielding/impact) = NOT.

---

# Performance considerations

- The pop-up fires a **battery** per discipline: Batting = 6 queries (core +
  positions + opposition + 3 matchup), Bowling = 4 (core + opposition + 2
  matchup), plus profile/gender/search. Today (flag off, pre-aggregated parquets)
  these are cheap.
- Under the ball engine each query re-aggregates raw balls, so it is HEAVIER.
  Three mitigations already in `db.js` make it viable and MUST be relied on:
  1. **Player-scoped base** (`playerScopeFor`): the reconstruction rebuilds only
     SA Yadav's involved balls, not every player's — and every pop-up section is
     player-LOCAL, so this applies to all of them (byte-identical, fast).
  2. **Queue-aware widening** (`widenForPendingQueries`): the same-scope
     same-player section battery folds into ONE materialised `batting` table +
     ONE `matchup_batting` table (union of their columns) instead of 6 rebuilds.
  3. **Column pruning** (`neededViewColumns`): only the ~8–12 columns each query
     names are aggregated, not all 74.
- **Net:** the Batting tab should materialise 2 player-scoped tables (`batting`,
  `matchup_batting`) once; Bowling likewise (`bowling`, `matchup_bowling`). P4
  should measure warm/cold first-open latency (single-player scope over
  `deliveries_m_t20` is the ~3 s warm case measured in Step 0) and confirm the
  fold actually collapses the battery. Watch the matchup queries: coverage +
  coarse + fine are 3 reads of `matchup_batting` — they share scope+player+columns
  so should fold to one build, but verify.
- Fielding (P3) reads `fielding_events` (small, pre-aggregated grain) — cheap,
  independent of the ball engine.

---

# Concerns / assumptions / ambiguities

- **Assumption (none forced on numbers):** all anchors above are exact against
  `data/wave1_out/`, which reproduces the standing anchor. If the production
  snapshot has drifted since Jul 30, P1 must re-derive against the live data —
  but the QUERY SHAPES and ball-engine mapping are snapshot-independent.
- **Ambiguity (D4, flagged, not resolved):** the SR-vs-Economy inconsistency in
  the plan's illustrative examples — reading (A) vs (B). Owner ruling needed
  before P2 wires slices. I did NOT resolve it.
- **Scope flag (Rule 2 trace):** the plan removes the pop-up's Player-Profile
  overlay filters "EXCEPT Team". The current overlay is date/positions/opposition/
  **vs** (bowling style) — none of these is a "Player Profile" filter in the
  leaderboard sense (country/role/hand). The `vs` bowling-style narrowing is
  today served by switching to `matchup_batting`; under the full palette it
  becomes matchup mode. I flag that "Team" (the one kept filter) is NOT currently
  a pop-up overlay dim at all — it's added new in P2. This traces to the owner's
  "players have multiple teams at domestic level" ruling; no action needed, just
  noting the current pop-up has no Team filter to preserve.
- **No product decisions made.** D4 is a draft; the fielding section content,
  the slice reading (A/B), and any AND/OR logic are the owner's to rule.
```
