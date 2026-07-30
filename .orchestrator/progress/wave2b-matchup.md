# Wave 2b — matchup views from the ball layer (behind the flag)

Branch `ball-layer`. Owner decision 67. Predecessors: `progress/wave2a-ball-engine.md`,
`wave2s-perf.md`, `wave2s2-softspots.md`. Numbers-sacred: with the flag ON, every matchup
number is byte-identical to the flag-OFF (matchup-parquet) path; matchup anchors reproduce
FROM BALLS.

## STATUS: COMPLETE — all acceptance checks green, 0 mismatches, anchors on screen.

## What shipped
Behind the existing `?engine=ball` flag, the `matchup_batting` / `matchup_bowling` views are
now RECONSTRUCTED from the six delivery files joined to the `profiles` view, instead of
reading matchup_batting.parquet / matchup_bowling.parquet — the exact mirror of Wave 2a for
the plain views. `buildMatchupQuery` (table.js), the matchup namespaces (metrics.js),
filters.js and playerData.js are BYTE-UNTOUCHED; the whole swap lives in the view definition.

Files (mine only): NEW `src/ballEngineMatchup.js`; `src/ballColumns.js` (matchup vocabularies
+ always/whole-innings sets + discipline dispatch); `src/db.js` (4-view engine wiring). No
wall-file change was needed (metrics/table/filters/playerData/export_parquet/pipeline/.github
all untouched — as required). config.js was touched ONLY for local testing and reverted (0 diff).

### `src/ballEngineMatchup.js` — the reconstruction generator
Faithful port of export_parquet.py's `run_ball_layer_gates()` oracle (orx_mbat / orx_mbowl),
which the pipeline reconciles cell-by-cell against the shipped matchup parquets (0 mismatches).
- **matchup_batting** grain = (match_id, innings_number, batter_id, bowling_type), keyed by the
  BOWLER's `COALESCE(profiles.bowling_type, profiles.bowling_group, '(unmapped)')`. `mb` GROUP BY
  over the striker's faced balls; `tta` (team-vs-type) only when a team_rel_* column is asked.
- **matchup_bowling** grain = (match_id, innings_number, bowler_id, batting_hand,
  batting_position), keyed by the STRIKER's `COALESCE(profiles.batting_style, '(unmapped)')`;
  batting_position (the striker's own position, off the ball column) is part of the PK. `mbowl`
  GROUP BY over the bowler's balls; `thp` (team-vs-hand,position) only for team_rel_*.
- Reproduces EVERY column: totals, dismissals (bowler-credited: matchup_batting dis_* / phase
  `_dismissals` via `bowler_credited_wkts`; matchup_bowling wkt_* via the flat wicket_kind +
  the wickets_extra overflow list), phase families (pp/mid/death + odi_ incl. decision-63
  `_dots`/`_fours`/`_sixes`/`_dismissals`), composition (ones/twos/threes/nb_*/non_boundary_runs),
  and team_rel_* (FLOAT). Two additions the oracle carries as helper-only, required for a
  drop-in VIEW: **odi_* NULL for The Hundred** (balls_per_over=5), and **exact type casts** to
  the shipped parquet (counts DOUBLE, batting_position BIGINT, team_rel_* FLOAT, keys/year/month).
- **`(unmapped)` bucket IS produced** (the coverage denominator "N of M balls"). Women have no
  profiles → every women's ball maps to `(unmapped)`; the app greys Vs for women, so those rows
  stay honestly empty (verified: no crash, empty Vs).
- **Grain note honoured:** NO plain crease union — a batter who faced 0 balls has no matchup row
  (`WHERE batter_id IS NOT NULL` + group by the striker). No zero-ball recovery.
- **Pruning (Layer 1) + lean base (Layer 2):** query-shaped like ballEngine.js — emits only the
  aggregates + CTEs the query's columns need; the base projects only the ball columns the
  generated SQL names (token-scan), so the `wickets_extra` LIST is dropped unless a dis_*/wkt_*
  column is asked. kindct uses `list_filter`/`len` (scalar per row) — NEVER a bare
  `FROM b, UNNEST(...)` (the 6 s/use WASM trap). windowPredicate (Wave-3) threaded but empty.

### `src/db.js` — 4-view engine wiring
- `engineViews` = batting/bowling/matchup_batting/matchup_bowling; `engineViewSql()` dispatches
  to ballEngine (plain) or ballEngineMatchup (matchup) by view name. createEngineViews,
  materialize, rebuildEngineFull, viewBackedBy all extended to the four.
- `enginePlanDisciplines` detects `\bmatchup_batting\b` / `\bmatchup_bowling\b` (the leading
  `matchup_` kills `\bbatting\b`'s boundary, so a matchup query never plans a plain view and
  vice-versa — a query only ever touches one family).
- **Scope cache + file scoping REUSED unchanged:** `scopeForQuery` lifts the SAME
  gender/match_type/team_type/match_date literals buildMatchupQuery's WHERE carries, so the
  matchup views scope by gender+format exactly like the plain views; caching/queue-widening key
  on the view name as the "discipline".
- **Player-scoping extended to matchup** (Wave-2s2 FIX 1 mirror): the popup fires single-id
  matchup queries (`batter_id='X'` on matchup_batting, `bowler_id='X'` on matchup_bowling). db.js
  pushes that into the base ball WHERE so a popup rebuilds ONLY that player's matchup rows —
  BYTE-IDENTICAL because gated on ballColumns' whole-innings rule (never when a team_rel_* column
  is needed; matchup team_rel needs the whole innings' balls). matchup_batting's player predicate
  is just the striker equality (no crease union at the matchup grain).

## VERIFICATION — byte-identical, multiple independent proofs (native DuckDB over data/wave1_out)
1. **Full-schema reconstruction == parquet, cell-by-cell:** matchup_batting **964,860 rows / 74
   cols / 0 bad cells / 0 missing/invented keys**; matchup_bowling **1,354,907 / 66 / 0**
   (incl. odi Hundred-NULL + team_rel FLOAT precision). Pruned column sets also 0 bad cells.
2. **23-scenario buildMatchupQuery harness** (REAL `buildQuery` matchup mode + REAL scopeForQuery
   + neededViewColumns, reconstruction flag-ON vs parquet flag-OFF, symmetric-difference of full
   result rows): **23/23 PASS, 0 differing rows** — batting Vs coarse (Pace/Spin) AND fine types
   (Off-spin/Leg-spin/Fast); bowling Vs left/right-handers; striker-position filters; T20/ODI/red
   + club + date-window + search + opposition scopes; **pins (single-id IN → correctly NOT
   player-scoped)**; and 6 **player-scoped popup** shapes (coverage/coarse/fine/position-overlay,
   bowling hands). Re-run clean after the config revert.
3. **Matchup anchors from the reconstruction AND an independent deliveries check (decision-39):**
   - SA Yadav vs Spin = **38 inns / 454 runs / SR 140.99**, coverage **913 of 1,027** — reconstruction ✓, independent ✓.
   - Bumrah vs RHB, striker pos 1–2 = **27 inns / 177 balls / 9 wkts** — reconstruction ✓, independent ✓.
4. **Plain-view NO-REGRESSION** (my db.js changes touch shared machinery): 12/12 plain
   buildQuery scenarios byte-identical (incl. the **2,813** leaderboard + popup player-scoped);
   plain anchors 2,813 / Karanbir 2,454 / SA Yadav 60·1,544·29.13·150.34 unchanged.

## BROWSER (localhost:8000, ?engine=ball, 1280×800) — 0 console errors flag-ON AND flag-OFF
- Flag ON: boots clean; **plain anchors on screen** (2,813 / Karanbir 2,454·54.53·175.29 / SA
  Yadav 64 mat·60·1,544·29.13·150.34); **Stats Vs Spin** = 2,401 players, SA Yadav 38·322·454·
  SR 140.99, composition Pace/Spin/Uncat 57.5/31.4/11.1% (Uncat = coverage 913/1027); **Vs fine
  Off-spin** = 1,981 (the fine bowling-type dropdown populated from the unscoped DISTINCT query —
  no OOM); **player popup Matchups** render byte-identical ("covers 913 of 1,027 balls (88.9%)",
  SA Yadav vs Spin 38·322·454·140.99, fine Off-spin 20·112·165·147.32); **Graph Builder Vs Bar**
  renders ("Runs — 15 most-capped, Men's T20s (international), vs Spin": JC Buttler 470, …). The
  `SELECT *` matchup Line dim (timeseries.js) fires the DESIGNED star-expansion full-set warn and
  rebuilds all columns (slower, correct) — no error.
- Flag OFF: boots clean, Vs Spin renders 2,401 (identical values), 0 errors.

## TIMINGS (DuckDB-WASM, warm-network localhost, Men/T20/International anchor scope)
| Action | flag ON | flag OFF |
|---|---|---|
| matchup_batting leaderboard — cold (new scope, reconstruction build) | **857 ms** | 200 ms |
| matchup_batting leaderboard — WARM | **56–63 ms** | 167 ms |
| matchup_bowling leaderboard — cold | **816 ms** | 148 ms |
| matchup_bowling leaderboard — WARM | **59–62 ms** | 144 ms |
| Graph Bar matchup fetch (top-N by Spin runs) | 51–81 ms | — |
| Graph Line `SELECT *` matchup (full-set rebuild, star fallback) | ~2,668 ms | — |

Warm flag-ON (~60 ms) is FASTER than flag-OFF (~150 ms): the materialised reconstruction table
carries ~18–20 lean columns vs the parquet's 74/66. Cold ~0.8 s is comparable to (better than)
the plain cold. No OOM on the largest scope (the unscoped context-only DISTINCT build over all 6
files is cheap — ~0.4 s native — because it carries no heavy aggregates).

## Gotchas for successors (Wave 3 / cutover)
- Wave 2a/2s/2s2 gotchas all still apply (super overs excluded in base; wickets_extra is a scalar
  list_filter, never UNNEST; matchup dis_*/wkt_* need wickets_extra in the base projection).
- **matchup_batting's `is_hundred` is internal only** (NULLs odi_*), NOT an output column — the
  export schema has no is_hundred (orx carries it as a reconcile helper). Same for matchup_bowling.
- **team_rel_* are dead in the UI** (no metric references them) but MUST stay correct for the
  full-schema / `SELECT *` fallback; they are the ONLY whole-innings (non-player-local) matchup
  columns, so they gate popup player-scoping off when present.
- **`src/graph/timeseries.js` keeps `SELECT * FROM <matchup ns>`** for two Line x-dims — now that
  matchup is engine-backed this forces a full 74/66-col rebuild (~2.7 s) + the designed warn.
  Naming those columns (as Wave 2s2 FIX 2 did for the plain innings dims) would make matchup Line
  charts as fast as the rest, but timeseries.js is outside this task's ownership → SUGGESTION, not
  a change.
- Local flag-ON testing: an `./explorer` symlink → data/wave1_out + a TEMP DATA_BASE_URL override
  in config.js (BOTH reverted/removed here — config.js is back on the R2 URL, 0 diff, symlink gone).
- Do NOT push or run the pipeline. The delivery files aren't on R2 yet; production stays flag-OFF.

## Wave-3 (window) notes
- `windowPredicate` is threaded into ballEngineMatchup's base WHERE (present-but-empty), the same
  seam ballEngine.js has. A delivery-window filter lands there BEFORE the mb/mbowl aggregation and
  needs no projection entry (the reverse clocks / phase columns it reads are already on the ball
  rows). Innings-under-a-window at the matchup grain = COUNT over matchup rows with ≥1 in-window
  ball — the grain is already per-faced-ball, so it composes naturally.
