# D4 Frontend — build plan & handoff

Status as of 2026-07-08. The D4 **data layer is DONE, deployed to R2, verified**
(gates + independent delivery-level hand-checks). This document is the plan for the
remaining D4 **frontend** work, split into 5 small, independently-reviewable pieces so
each fits one working session and ends at a screenshot-verifiable state (SPEC §8.6).

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

**Piece 1 — Data plumbing + profile filters (D4.2).** Register `player_profiles`,
`matchup_batting`, `matchup_bowling` in config.js + db.js views. Add the 4 profile filters
to the Compare Stats filter bar; options limited to values with matched players; unmatched
excluded only when a profile filter is active. Women/unmapped → inert. *Review:* filter by
"leg-spin" or "India" works. (Small/foundational — do inline, not via subagent.)

**Piece 2 — New table metrics.** Surface bowler wicket-type breakdown (from the 6 new
bowling cols) and batting progression SR (first-10-ball SR, 11–20, 21+) as selectable
metrics in metrics.js + table. Respect `hasMetricData`. *Review:* new sortable columns.

**Piece 3 — Free splits.** Batting-position, opposition (international only), and
dismissal-type breakdowns — no new data, UI only. *Review:* splits read correctly for a
known player.

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
