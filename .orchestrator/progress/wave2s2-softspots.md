# Wave 2s2 — ball-engine perf soft-spots (3 targeted fixes)

Branch `ball-layer`. Follows Wave 2s (`progress/wave2s-perf.md`). Owner decision 67,
"SPEED PULLED FORWARD". Numbers-sacred: every fix proven BYTE-IDENTICAL to flag-OFF.

## STATUS: COMPLETE — all acceptance checks green, 0 mismatches, anchors on screen.

Files changed (mine only): `src/db.js`, `src/ballEngine.js`, `src/ballColumns.js`,
`src/graph/timeseries.js`, `src/main.js`. (`config.js` touched only for LOCAL testing —
reverted; tree clean.)

## FIX 1 — popup single-player base scoping (~5 s → ~1 s core, warm 12 ms)
A one-player popup query (`… FROM batting WHERE … AND batter_id='X' …`, playerData.js) used to
rebuild EVERY player's innings for the scope, then throw all but X's away. db.js now detects a
genuine single-id equality (`singlePlayerId`) and pushes a player-involvement predicate
(`playerBasePredicate`) into the reconstruction's BASE ball WHERE (new `playerPredicate` option
threaded through ballEngine `baseWhere`/`assemble`/`buildInningsViewSql`), so it builds only X's
innings.
- **Base predicate (batting):** `batter_id=X OR non_striker_id=X OR player_out_id=X OR
  len(list_filter(wickets_extra, w -> w.player_out_id=X))>0` — striker OR non-striker OR flat
  dismissed OR a 2nd-wicket overflow dismissal. **Bowling:** `bowler_id=X`.
- **PLAYER-LOCAL GUARD (ballColumns.js):** player-scope ONLY when NONE of the whole-innings columns
  are needed — batting `{team_inns_balls, team_rel_sr, team_rel_dot_pct, team_rel_bpb,
  team_rel_nbsr}`, bowling `{team_rel_econ, team_rel_pbe, team_rel_dot_pct, team_rel_sr}` (the team
  TOTAL/relative columns need the whole innings' balls). Everything else is player-local (per-player
  CTEs `bat`/`bagg`/`dis`/`wkk`/`posx`/`disp`/spells still see all of X's own balls; the context
  `ictx`/`bagg` ANY_VALUE columns are innings-constant so a partial ball set still yields the right
  value). `columnsArePlayerLocal(discipline, need)` gates it; a whole-innings column falls back to
  the whole-scope reconstruction. Cache signature + queue-widening both key on the player predicate,
  so a player-scoped table is never reused for a whole-scope query (or a different player), and a
  same-player popup battery folds into ONE build.
- **Detection is safe:** the leaderboard pin exemption uses `id IN (…)` (never `=`) and the R.Pos
  join uses `pos_batter_id = <col>` (a column, not a literal), so neither is matched; requires
  exactly one distinct id value. Confirmed by the harness (pins/rpos byte-identical).
- **Binder-error fallback** drops BOTH the pruning AND the player scoping (whole-scope full = the
  proven byte-identical oracle).

## FIX 2 — graph Line pruning (~1 s → 31–82 ms)
`timeseries.js` did `SELECT * FROM <ns>` in the Line **window** (innings index) and **join**
(event/venue/result) builders — the `*` forced the flag-ON engine to rebuild all 74/71 columns.
New `baseProjection(ns, fragments)` names only the columns the outer query reads (via
`neededViewColumns` over the metric expr + sample + WHERE + bucket/ord, intersected with the
innings vocabulary + always-added keys). Matchup namespaces keep `*` (parquet-backed, no engine, and
not the innings vocabulary). Byte-identical by construction (pass-through projection, same rows/
aggregates); the star-expansion `console.warn` no longer fires for these dims.

## FIX 3 — background pre-warm (fetch-based, zero serialiser contention)
After boot, flag-ON only, `prewarmBallEngine()` fires a plain background `fetch()` of the SAME
versioned URL db.js registered for `deliveries_m_t20.parquet` (the default Men/T20 bucket), draining
the body into the HTTP cache so DuckDB's later ranged reads come off warm bytes. **Deliberately a
`fetch`, NOT a DuckDB query** — a first draft ran a light DuckDB scan, but that enters the serialised
engine queue and cost the immediate-search case ~550 ms (measured); the `fetch` prewarm has ZERO
query-engine contention (immediate search back to baseline). Non-blocking, best-effort, no-op
flag-OFF (byte-untouched — flag-OFF never fetches a delivery file). Warms ONE file (the default).
Confirmed firing: fetched the full 20 MB `deliveries_m_t20.parquet?v=172ba09290dc`.

## VERIFICATION (localhost:8000, ?engine=ball, 1280×800)

### Byte-identical — FIX 1 (cell-by-cell vs innings parquet, ALL player-local columns)
Player-scoped FULL reconstruction vs `read_parquet(batting/bowling_innings.parquet)`, per player,
keyed by (match_id, innings_number): **0 bad cells, 0 row diffs** —
SA Yadav 345 bat / 3 bowl · Bumrah 149 / 442 · **Sciver-Brunt (women's files)** 431 / 379 ·
RG Sharma 807 / 96. **Guard proven:** a single-player query needing `team_inns_balls`/`team_rel_sr`
is NOT player-scoped → those columns match the parquet exactly (60 rows, 0 bad cells).

### Byte-identical — harness (50 scenarios) flag-OFF-orig == flag-OFF-new == flag-ON-new
REAL `buildQuery`/`buildMatchupQuery`/`fetchLineData`, per-scenario digests, **0 mismatches**:
16 gender×format leaderboards (bat+bowl, both genders, T20/50-over/red/mix), team-type + date
windows + no-date, phase columns, positions/opposition/teams/search filters, **pins** (single-id
IN — confirms leaderboard NOT player-scoped), **R.Pos** column, the **matches** secondary query,
matchup **Vs Spin**, and EVERY graph Line X-dim (innings/year/month/event/venue/result/position/
opposition/innings_of_match) incl. the FIX-2 window/join dims, SR/runs/average/econ, both
disciplines. Flag-OFF byte-UNTOUCHED (identical digest string).

### Anchors ON SCREEN (flag-ON, real UI)
Leaderboard 2,813 players · Karanbir Singh 2,454 (54.53 / 175.29) · SA Yadav 64 mat / 60 inns /
1,544 runs / 29.13 avg / 150.34 SR / HS 100. Popup (batting) tiles 60·1,544·29.13·150.34·HS 100 +
by-position/wicket-type/vs-opposition; Bowling toggle 1·2·2.50·econ 5.00·BBI 2-5·matchups 6/6 balls.

### Independent DuckDB check (decision 39 — my own single-pass shape off the DELIVERY parquet)
SA Yadav: 60 inns / 1,544 runs / 1,027 balls / 53 dismissals → 29.13 avg / 150.34 SR. Distinct
raw batter_ids (crease) = 2,810 (app's 2,813 = the documented +3 name-variant quirk).

### Timings (query-only, localhost warm-network)
| Action | before | after |
|---|---|---|
| Popup batting **core** cold (fresh scope) | 3,239 ms | **1,060–1,304 ms** |
| Popup battery total (core+pos+opp+matchups) | 5,596 ms | **2,429 ms** |
| Popup core WARM | — | **12 ms** |
| Graph Line innings (window) | 267 ms | **82 ms** |
| Graph Line event/venue/result (join) | 1,030–1,062 ms | **31–51 ms** |
| Cold first search — nowarm baseline | — | 1,926 ms |
| Cold first search — fetch-prewarm, immediate | — | 1,869 ms (no penalty) |

`node --check` clean on all 5 files. 0 console errors flag-ON (Stats/Graphs/popup) + flag-OFF; no
star-expansion warn.

## Notes / open concerns for Wave 2b/3
- **Popup core residual ~1 s** is the single-core WASM scan of the id columns across the format's
  ball files (no row-group pruning on batter_id — the files are sorted by match/innings/over). Also
  the popup scope carries NO gender (playerData `includeGender:false`), so a men's-player popup scans
  BOTH gender t20 files; can't narrow without touching playerData (forbidden). Further speed here
  needs a data-layout change (out of scope). The popup also pays the base scan TWICE (core awaited,
  THEN positions/opposition/matchups fire in parallel; positions needs `batting_position` → a second
  player-scoped build) — inherent to playerPage.js's fire order, not FIX 1.
- **FIX 3 on localhost** shows little benefit (local disk ≈ free); its value is the R2 network
  pre-pay in production. On production a fast user (searches <~2 s after boot) sees no benefit but
  no penalty; a typical user (picks a date first) searches off warm bytes.
- **No wall-file changes** were needed (metrics.js / table.js / filters.js / playerData.js /
  export_parquet.py / pipeline / .github all untouched). The player-local/whole-innings split is
  defined in ballColumns.js as instructed.
