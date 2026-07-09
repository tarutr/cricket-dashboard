# D4 Frontend — build plan & handoff

Status as of 2026-07-08. The D4 **data layer is DONE, deployed to R2, verified**
(gates + independent delivery-level hand-checks). This document is the plan for the
remaining D4 **frontend** work, split into 5 small, independently-reviewable pieces so
each fits one working session and ends at a screenshot-verifiable state (SPEC §8.6).

**Progress: Piece 1 ✅ owner-approved · Piece 2 ✅ built + verified (not yet gate-reviewed)
· Piece 3 ✅ built + verified (not yet gate-reviewed; owner design answers = decision 28)
· Pieces 4–5 remain.** Branches: `d4-piece1-profile-filters`, `d4-piece2-metrics`,
`d4-piece3-free-splits` (each stacked on the previous, not yet merged to `main`).

> **RESTRUCTURE (2026-07-09, decision 29) — READ FIRST.** After Piece 3 the owner
> ruled the one-page layout overloaded and approved a full restructure around three
> destinations: **Leaderboard** (slim scope strip + ONE "All filters" drawer + filter
> pills + column presets + toolbar "Group rows"), **Player pages** (new home for all
> single-player features: splits, dismissal fingerprint, progression, matchups;
> supersedes SPEC §2 "no player pages" and absorbs D5's pop-ups), and **Graph
> Builder** (unchanged). Remaining work is re-sequenced as gates **R1** (leaderboard
> slim-down) → **R2** (player pages) → **R3** (matchups = old Pieces 4–5, built
> directly into the player page; decisions 23/24 confirmed there) → polish. The
> Piece 4–5 specs below still define matchup content/coverage rules; only their
> HOME changed. Branch chain continues: `d4-r1-leaderboard` stacked on
> `d4-piece3-free-splits`. Owner reviews on **localhost:8000**
(`python3 -m http.server 8000`) — the R2 CORS policy allows localhost but NOT Vercel
preview domains, so branch previews on Vercel currently error until CORS is widened
(deferred, owner's call).

Read alongside: `SPEC.md` (§4.1 calc rules, §5 Compare Stats, §8 engineering rules),
`SPEC_ADDENDUM_DATA.md` (Phase D4), and `review/owner_decisions.md` (all rulings —
these override the addendum where they conflict).

## Data the frontend now has (live on R2, not yet wired into the browser)

New/updated Parquet objects under the `explorer/` prefix:

- **matchup_batting.parquet** — grain `(match_id, innings_number, batter_id, bowling_type)`.
  Columns: `bowling_type`, `bowling_group`, `batter_name`, `batting_team`, `bowling_team`,
  `match_type`, `gender`, `team_type`, `match_date`, `year`, `month`, `runs`, `balls_faced`,
  `dots`, `fours_hit`, `sixes_hit`, `dismissals`.
- **matchup_bowling.parquet** — grain `(match_id, innings_number, bowler_id, batting_hand)`.
  Columns: `batting_hand`, `bowler_name`, `batting_team`, `bowling_team`, `match_type`,
  `gender`, `team_type`, `match_date`, `year`, `month`, `balls`, `runs_conceded`,
  `wickets`, `dots`, `fours_conceded`, `sixes_conceded`.
- **player_profiles.parquet** — one row per matched player (exported since D2, still NOT
  registered in the browser). Columns include: `player_id`, `registry_name`, `full_name`,
  `country`, `dob`, `playing_role`, `role_group`, `role_subgroup`, `batting_style`,
  `bowling_style`, `bowling_arm`, `bowling_type`, `bowling_group`, `teams_played_for`
  (pipe-separated), `headshot_url`, `has_real_headshot`, `match_tier`.
- **bowling_innings.parquet** gains: `wickets_bowled`, `wickets_lbw`, `wickets_caught`,
  `wickets_caught_and_bowled`, `wickets_stumped`, `wickets_hit_wicket` (sum = `wickets`).
- **batting_innings.parquet** gains: `fb1_10_runs`, `fb1_10_balls`, `fb11_20_runs`,
  `fb11_20_balls`, `fb21p_runs`, `fb21p_balls` (faced-ball progression buckets).

### Conventions baked into the matchup data
- `bowling_type` = specific style when known; the pace/spin **group** name when only that
  is known (the 10 owner-ruled bare-"slow" bowlers appear as `'Spin'`); `'(unmapped)'`
  when the bowler has no mapped style. `bowling_group` is `Pace` / `Spin` / `'(unmapped)'`.
- The `'(unmapped)'` rows exist ON PURPOSE: coverage denominator **M** = a player's total
  balls (all buckets); **N** = balls where the opponent's style is mapped (bucket ≠
  `'(unmapped)'`). Every matchup stat MUST show "based on N of M balls (X%)" — no
  coverage figure, no stat (SPEC_ADDENDUM D4.3).
- `batting_hand` = `'Right-hand bat'` / `'Left-hand bat'` / `'(unmapped)'`.

## Owner rulings that shape the UI (confirmed)
- **Matchups are men-only in practice.** Women's coverage is ~0%. Decision 21: when a
  section/filter has no mapped data (incl. all women's matchups, unmapped players), show
  it **inert / greyed with a "–" and an honest "no style data" note — never hide, never
  silently empty.**
- **Dismissal attribution (decision 23, confirmed):** matchup `dismissals` already counts
  ONLY bowler-credited kinds — run-outs etc. are excluded. Display "out to pace/spin" from
  this field as-is.
- **Bare-slow fine view (decision 24, confirmed):** in the fine "vs off-spin / leg-spin /
  …" view, the `'Spin'` bucket (bare-slow bowlers, no specific type) is labelled
  **"Spin (unspecified)"**. In the coarse pace-vs-spin view they count as Spin.
- **Profile filters (D4.2):** playing-role, batting-hand, bowling-style, teams-played-for
  in Compare Stats. Each filter's options show ONLY values that have matched players.
  Filter results exclude unmatched players **only when a profile filter is actively
  applied**; otherwise unmatched players appear as normal.
- **Career compare mode: SHELVED** (do not build).
- **Venue splits & club-opposition splits: DEFERRED** (decision 20). Opposition split
  ships for INTERNATIONAL cricket only (country names are clean).

## Frontend module map (existing, plain ES modules, no framework)
`src/config.js` (DATA_BASE_URL + PARQUET_FILES list) · `src/db.js` (duckdb-wasm setup;
view map `players/matches/batting/bowling/player_matches` → parquet) · `src/metrics.js`
(THE single metrics module — every metric defined once as {key,label,shortLabel,
discipline,sqlExpression,higherIsBetter,format,isPhaseMetric,zeroIsData}) ·
`src/filters.js` · `src/advanced.js` (AND/OR condition builder) · `src/table.js` ·
`src/state.js` · `src/main.js` · `src/graph/*` (charts, card, players, radarGroups, graph).
Rules: metrics defined ONCE in metrics.js; `hasMetricData` predicate everywhere; no file
over ~600 lines; honest auto-descriptions.

## The 5 pieces (each ends reviewable)

**Piece 1 — Data plumbing + profile filters (D4.2). ✅ DONE + owner-approved.** Registered
`player_profiles`, `matchup_batting`, `matchup_bowling` in config.js + db.js views. Added
the 4 profile filters (Role, Batting hand, Bowling, Teams played for) to the Compare Stats
filter bar; options limited to values with matched players; unmatched excluded only when a
profile filter is active; the semi-join lives in `profileSemiJoinSql` (state.js) injected via
`buildScopeClauses(idColumn)`. Owner design calls realized: **Role = both levels** (broad
Batter/Allrounder/Bowler + cascading detailed sub-role); **Bowling = the 10 specific types**;
**Women view = greyed with note "We don't have profile data on Women yet."** (0% of women
have a profile); **Men is now the default gender**; **no automated search — the results table
is blank on first load with a "Show results" button and reverts to it on any filter change**
(table only; graph still auto-updates). Numbers cross-checked exact vs raw R2.

**Piece 2 — New table metrics. ✅ DONE + verified (awaiting gate review).** Added to
metrics.js (column picker lists them automatically, no table changes): batting
`sr_first10` / `sr_11_20` / `sr_21plus` (faced-ball progression SR, all formats, not
phase-gated) and bowling `wkt_bowled` / `wkt_lbw` / `wkt_caught` / `wkt_caught_and_bowled`
/ `wkt_stumped` / `wkt_hit_wicket` (counts, the six sum to `wickets`). Verified exact vs raw
R2 (Karanbir Singh 140.48/155.23/213.97; Ali Dawood 54/13/43 = 113).

**Piece 3 — Free splits. ✅ DONE + verified (awaiting gate review).** Owner chose BOTH
split styles (decision 28): batting-position (individual 1–12 chips) and opposition
(international only) as *filters*, PLUS a table-only "Split by" breakdown (one row per
player × position / opposition / dismissal kind), and 24 dismissal-breakdown batting
columns (every kind, counts + % of dismissals, "Dismissals" picker section). Matches
column switches to slice-honest match counts under any innings-level filter/split.
Graph honors the filters, ignores Split-by. All numbers cross-checked exact vs raw R2.
*Review:* splits read correctly for a known player.

**Piece 4 — Matchup mode: batting (D4.3a).** New comparison mode: batter × bowling-style
(coarse pace/spin + fine type), every stat with its N-of-M coverage line, inert for
women. *Review:* "Kohli vs left-arm orthodox, T20s since 2023" vs owner knowledge.

**Piece 5 — Matchup mode: bowling + polish (D4.3b).** Bowler × batting-hand; consistent
inert "–"/coverage treatment everywhere. *Review:* full matchup feature = the D4 gate.

## Delegation
Owner runs Opus 4.8 Extra as orchestrator. Small/foundational (Piece 1 plumbing) inline;
larger UI pieces → Sonnet subagents (SPEC §8 design north star: Guardian player-guide
editorial look; Bricolage Grotesque display / Inter body). Verify each piece with the
preview tools; owner reviews on the preview URL, never code.

## Open owner items (parallel, non-blocking)
- `review/ambiguous_matches.csv` resolutions (auto-applied on next pipeline run once pushed).
- New-player review loop is live (`review/PLAYER_REVIEW.md`).
