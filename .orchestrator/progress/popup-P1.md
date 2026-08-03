# P1 — Player pop-up CORE on the ball engine (confirm + perf)

Branch `ball-layer`. Sub-program of the ball-layer (`.orchestrator/popup-ballengine-plan.md`),
follows P0 (`.orchestrator/progress/popup-P0.md`). Numbers-sacred (CLAUDE.md Rule 1).

## STATUS: COMPLETE — all 10 sections byte-identical flag-ON for TWO players; no rebuild needed.

## Approach + key risk (stated up front)
P0 established the pop-up ALREADY computes every section from balls flag-ON (db.js re-points the
four views to reconstructions) AND that db.js already carries the **player-scoped fast path**
(Wave 2s2 FIX 1: `singlePlayerId`/`playerBasePredicate`/`playerScopeFor`, gated on
`columnsArePlayerLocal`). So P1 = **CONFIRM byte-identical + measure**, not rewrite. Key risk: a
mistaken "improvement" to a numbers-critical file (db.js / ballEngine / playerData). Mitigated by
making **ZERO code changes** — the fast path was already built and proven; I only verified.

## Files changed: NONE (src/ tree clean).
`src/config.js` touched ONLY for local ball-file testing (DATA_BASE_URL → `/explorer/`) — REVERTED;
`git status --short src/` clean. No pop-up rebuild, no new filters, no fielding (all out of P1 scope).

## Was a player-scoped fast path needed/built?
**NO — already present and engaged.** The pop-up fires `… FROM batting WHERE <scope> AND
batter_id='X' …` (playerData.js); db.js detects the single-id equality and pushes a player-
involvement predicate into the base ball CTE, so ONLY that player's innings rebuild. Every pop-up
section uses player-LOCAL columns only (no team_inns_balls / team_rel_*), so `columnsArePlayerLocal`
is true for all of them → the fast path applies to the whole battery. Confirmed engaged by the perf
profile (cold rebuild dominant, warm = engine-cache hit) + unchanged code + byte-identical numbers.

## VERIFICATION (localhost:8000, symlink `explorer`→`data/wave1_out`, ?engine=ball, 1280×800)

### Byte-identical ON SCREEN — SA Yadav (271f83cd), all 10 sections == P0 anchors
- B1 hero: 60 inns · 1,544 runs · 29.13 avg · 150.34 SR · HS 100 ✓
- B2 how-out: Caught 43 · LBW 4 · Stumped 3 · Bowled 1 · Run Out 1 · C&B 1; Not out 7 of 60 ✓
- B3 progression: SR 1–10 133.19 · 11–20 148.79 · 21+ 178.55 ✓
- B4 positions: 3/22/551/29.00/153.06 · 4/34/967/32.23/150.39 · 5/4/26/6.50/108.33 ✓
- B5 opposition: all 14 teams exact (Australia 259 … Ireland 2), incl. USA/UAE avg "—" (NULL guard) ✓
- B6 matchups: coverage 913 of 1,027 (88.9%); coarse Pace 56/591/913/154.48/21.74/42, **Spin
  38/322/454/140.99/64.86/7 (standing anchor)**, Uncat 11/114/177; fine = all 8 types exact ✓
- W1 hero: 1 inn · 2 wkts · 2.50 · 5.00 · 3.00 · BBI 2-5 ✓
- W2 wicket types: Caught 2 ✓ ·  W3: Sri Lanka 1/2/2.50/5.00 ✓
- W4 matchups: coverage 6 of 6; LHB 1/4/4/1/6.00, RHB 1/2/1/1/3.00 ✓

### Byte-identical ON SCREEN — 2nd player: Sikandar Raza (26d041c4), all 10 sections == my
independent DuckDB targets (rich batting AND bowling all-rounder → every section populated)
- B1: 59 · 1,691 · 33.82 · 144.28 · HS 133 ✓  ·  B2: Caught 39/Bowled 6/Stumped 2/LBW 1/RunOut 1/
  C&B 1 (Σ50), Not out 9 of 59 ✓  ·  B3: 114.31 / 153.87 / 179.88 ✓
- B4: 1/3/205/68.33/169.42 · 3/5/118/29.50/140.48 · 4/37/1158/37.35/150.78 · 5/14/210/17.50/105.53 ✓
- B5: all 19 teams exact (Sri Lanka 267 … Oman 5), incl. Gambia/Seychelles/Australia/Oman "—" ✓
- B6: coverage 1,028 of 1,172 (87.7%); coarse Pace 54/625/955/152.80, Spin 50/403/531/131.76,
  Uncat 21/144/205; fine = all 7 types exact ✓
- W1: 58 · 64 · 21.59 · 6.84 · 18.94 · BBI 5-18 ✓  ·  W2: Caught 26/Bowled 24/LBW 9/C&B 3/Stumped 2
  (Σ64) ✓  ·  W3: all 19 teams exact (Namibia 10 wkts … 4 teams 0-wkt "—") ✓
- W4: coverage 1,057 of 1,212 (87.2%); RHB 57/638/713/38/6.71/18.76/16.79, LHB 49/419/500/20/7.16/
  25.00/20.95, Uncat 27/155/169/6/6.54/28.17/25.83 ✓

### Independent DuckDB re-derivation (decision 39) — two headline sections, BOTH players, from RAW
BALLS (`deliveries_m_t20.parquet`, two-level crease-union aggregation, NOT the app's shape)
- B1 batting: SA Yadav 60/1,544/53 diss/29.13/150.34/HS100/1,027 bf; Raza 59/1,691/50/33.82/144.28/
  HS133/1,172 bf — BOTH exact vs the innings-parquet target.
- W1 bowling: SA Yadav 1/2/2.50/5.00/3.00/BBI 2-5; Raza 58/64/21.59/6.84/18.94/BBI 5-18 — BOTH exact.
- (Full ball-vs-innings agreement gives two independent confirmations of every headline number.)

### Leaderboard anchors — UNCHANGED both ways
Flag-ON: 2,813 players · Karanbir Singh 2,454 (54.53/175.29/HS164) · SA Yadav 1,544 (29.13/150.34/
HS100) · Sikandar Raza 1,691 (33.82/144.28/HS133). Flag-OFF (no `?engine=ball`, innings parquet):
IDENTICAL — 2,813 / Karanbir 2,454 / SKY 1,544 / Raza 1,691. Byte-untouched by construction (no
code change on the query path).

### 0 console errors
Flag-ON leaderboard + both pop-ups (both discipline tabs) + flag-OFF leaderboard — all clean.

### Perf (click → hero tiles render, wall-clock end-to-end incl. profile fetch + shell + query)
| Case | ms |
|---|---|
| Cold open, fresh player (Sikandar Raza, player-scoped build) | ~3,558 |
| Warm re-open, same player (db.js engineCache hit) | ~1,003 |
The 3.5×  cold→warm speedup confirms the heavy player-scoped materialisation is the dominant cost
and is cached — i.e. the player-scoped path is engaged (a whole-scope rebuild would be the ~5.6 s
battery FIX 1 replaced / the ~19 s leaderboard reconstruction). Numbers are end-to-end wall-clock,
larger than Wave 2s2's query-only `ms` (core ~1 s), and consistent with it once profile-fetch +
render are included. Accepted ball-engine tradeoff (owner decision 67, "SPEED PULLED FORWARD");
residual per-open cost is the data-layout limit flagged in Wave 2s2 (out of P1 scope).

## Suggestions (NOT built — Rule 3, perf/product judgment for the owner)
- **Fold the batting battery into one build.** `playerPage.js fetchDisciplineData` AWAITS
  `fetchBattingCore` before firing positions/opposition/matchups, so the batting table is built for
  the core, then REBUILT to add `batting_position` (positions needs it; it is not an always-column).
  Firing all four batting fetches in ONE `Promise.all` would let `widenForPendingQueries` fold them
  into a single player-scoped batting build (+ one matchup build). Trade-off: it fetches
  position/opposition/matchup data even for a 0-batting player (currently short-circuited), and it
  is a numbers-adjacent change to the pop-up fetch order — hence a Rule-3 owner call, not built here.
  (Wave 2s2 already flagged this "the popup pays the base scan twice" as inherent to the fire order.)

## Concerns
- None on correctness — every section byte-identical for two players, both entry via the leaderboard
  (table-row scope). I did NOT exercise the header-search fixed-scope entry path (Since-2020/T20/both)
  — it runs the same fetch functions + same db.js path, so it is covered by construction, but P2/P4
  may want a direct check.
- Cold per-open latency (~3.5 s end-to-end) is the accepted ball-engine cost; a real speed win needs
  the data-layout change (backlog #14), out of P1 scope.
