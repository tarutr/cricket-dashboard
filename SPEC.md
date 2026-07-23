# cricdb — Cricket Stats Explorer — Product & Build Specification (v2.0)

Owner: tarutr. Owner is a non-coder with deep cricket knowledge; all cricketing-logic
ambiguities must be resolved by asking the owner, never by assumption. This document is
the single build reference and describes the app **as it is today**. Where this spec is
silent, ask; do not invent.

> **This is a reference, not the live record of behaviour.** Every behaviour, UX
> semantic, and scope choice the owner has ruled on is logged — with dates and exact
> wording — in **`review/owner_decisions.md`** (the ONLY decision log, ~61 decisions),
> and the wave-by-wave build status is in **`.orchestrator/design-plan.md`**. Those two
> files are authoritative if this spec ever disagrees with them. The working contract
> (numbers-are-sacred, decisions-are-law, verification ritual) is `CLAUDE.md`; the
> orchestration rules are `.orchestrator/ORCHESTRATION.md`.

---

## 1. What this is

A static website for exploring cricket statistics across the full Cricsheet dataset
(men's **and** women's, all formats). It is a successor to the WT20 2026 fan dashboard
(`tarutr/wt20-guide`) but a **different site, different repo** — it carries over proven
design behaviours from v1 while being its own product.

Three surfaces, one page:

1. **Stats** — a filterable, sortable player-comparison **leaderboard table** (the tab
   is labelled "Stats"; formerly "Compare Stats" / "Leaderboard").
2. **Graphs** — a **Graph Builder** that turns the current player set into one of the
   eight chart types (see §6; the tab is labelled "Graphs").
3. **Player pop-ups** — clicking any player name (or using the header search) opens a
   centred overlay with that player's splits, dismissal fingerprint, progression, and
   matchups. The pop-up has its own scope drawer that re-scopes the whole overlay.

The player pop-up **supersedes** the v1 "no player profile pages" non-goal: single-player
detail now lives in these overlays (not a separate page, per owner ruling — see
`review/owner_decisions.md` decisions 31–32).

**Delivery model:** static browser app, plain ES modules, **no framework, no build
step**. DuckDB-WASM (vendored locally) runs SQL client-side over Parquet files hosted on
Cloudflare R2 and served through the custom domain **`data.the-cordon.com`**. There is no
backend, no server-side query API, and no hosted query database. The site is deployed on
Vercel (`cricdb.vercel.app`).

## 2. Non-goals (do not build)

- No user accounts, no login.
- No AI/chatbot query interface.
- No ESPN data (Cricsheet only; ESPN integration is a separate future project, not part
  of this app).
- No server, no backend query API, no hosted-for-queries database. **Static site only** —
  every query runs in the browser against Parquet on R2.
- No WC / "since last WC" toggles from v1.

**Formerly non-goals, now BUILT (do not re-add them to this list):**

- ~~No player role/type filters.~~ Superseded by Phase D4: the `player_profiles` table
  (from the Cricinfo sheet) powers playing-role, batting-hand, bowling-style, and
  teams-played-for filters. Profiles are men-only, so these are inert on the Women view.
- ~~No player profile pages.~~ Superseded by the player **pop-ups** (§7). They are
  overlays, not pages, per owner decision 32.

## 3. Architecture

```
cricket.duckdb  (Cloudflare R2 bucket `cricket-db`, key `cricket.duckdb`)
      │   maintained by THIS repo's ingestion pipeline (pipeline/ingest.py + the
      │   player_profiles rebuild); the old wt20-guide pipeline is decommissioned.
      ▼  GitHub Actions — pipeline.yml (daily cron + manual dispatch, concurrency-guarded)
   download DB → ingest new Cricsheet → fetch profiles sheet (Dropbox) →
   rebuild player_profiles → upload DB → run export_parquet.py → upload exports
      │
      ▼  export_parquet.py writes 8 Parquet files + manifest.json to R2 prefix `explorer/`
   explorer/players.parquet
   explorer/matches.parquet
   explorer/batting_innings.parquet
   explorer/bowling_innings.parquet
   explorer/matchup_batting.parquet
   explorer/matchup_bowling.parquet
   explorer/player_matches.parquet
   explorer/player_profiles.parquet
   explorer/manifest.json      (generated_at, data date-range/match_count, profiles
                                provenance, and per-file {rows, bytes, sha256_12})
      │
      ▼  HTTPS range requests via the custom domain data.the-cordon.com (immutable
      │  cache headers on the versioned data files; manifest.json is fetched no-store)
   Browser: DuckDB-WASM (@duckdb/duckdb-wasm, VENDORED locally under /vendor/, never
   hot-loaded from a third-party CDN at runtime). Reads manifest.json first, then
   registers each Parquet URL cache-busted with the manifest's per-file sha256_12
   and creates SQL views over them.
      │
      ▼
   Static frontend on Vercel: index.html + ES modules in src/. No framework, no build.
```

**Fallback rule:** if the manifest or any Parquet fetch fails, show a clear
human-readable error state with a Retry button — never a blank page or console-only
error. (Implemented in `src/db.js`.)

## 4. Data layer

### 4.1 Source-of-truth calculation rules (from the validated database reference — these are ABSOLUTE)

- Base table for all aggregation is `deliveries`. Never aggregate from `innings_batters`,
  `innings_bowlers`, or `bowling_spells`.
- `over_number` is 0-based. Over 1 = over_number 0.
- Legal delivery for BOWLER stats: `wides IS NULL AND noballs IS NULL`.
- Legal delivery for BATTER balls faced: `wides IS NULL` only (no-balls count as faced).
- Batter runs = `runs_batter`. Wides never credit the batter.
- Bowler runs conceded = `SUM(runs_batter + COALESCE(noballs,0) + COALESCE(wides,0))`
  — byes and leg-byes excluded. Never use `runs_total` for bowler stats.
- Bowler-credited wickets: join the `wickets` table; count only kinds in
  {bowled, lbw, caught, caught and bowled, stumped, hit wicket}.
- Batter dismissals (for average): count wickets rows where `player_out_id` = batter,
  any kind except {retired hurt, retired not out} (ask owner to confirm the exact
  not-out treatment of `retired out` before finalizing).
- Super overs (`innings.super_over = TRUE`) are excluded from ALL stats.
- Date filtering uses `matches.match_date_1`, never season columns.
- Boundary detection: a hit boundary is `runs_batter IN (4,6) AND is_not_boundary IS NOT TRUE`.
- Afghanistan does not exist in the data; no special handling needed beyond honest empty results.
- Player names are "initials + surname" (e.g. "RG Sharma"); search must match on substring,
  case-insensitive.
- T20 phases: powerplay overs 1–6 (over_number 0–5), middle 7–15 (6–14), death 16–20 (15–19).
  Phase columns are only meaningful for T20/IT20; they are still *stored* for other formats
  using the same over ranges but the UI must not surface phase metrics unless the format
  filter is exactly T20, IT20, or both.

### 4.2 Parquet schemas (written by `export_parquet.py`)

**Eight** Parquet files are exported (the v1 spec listed four). All aggregation is done
from the `deliveries` base table per §4.1. Compression is **zstd**; row-group size is
**~100 000**. The innings and matchup files (and `player_matches` / `matches`) are
**sorted by `match_date` then `match_id`** (with finer key columns after, for a stable
order) so DuckDB row-group pruning makes date-range filters cheap; `players.parquet` and
`player_profiles.parquet` have no match_date and are sorted by `player_id`.

Phase columns come in **two families**, both stored for all formats (§4.1):
`pp_* / mid_* / death_*` use the T20 over-ranges (0–5 / 6–14 / 15–19), and
`odi_pp_* / odi_mid_* / odi_death_*` use the ODI over-ranges (0–9 / 10–39 / 40–49). The
`odi_*` columns are written **NULL for The Hundred** (balls_per_over = 5); for The Hundred
the T20-family phases are computed from a legal-ball ordinal (pp = balls 1–25, mid 26–75,
death 76+) rather than over_number.

**players.parquet** — one row per player_id (every player selected in an XI).
- `player_id`, `player_name`

**player_profiles.parquet** — one row per matched player_id. A verbatim export
(`SELECT *`) of the non-Cricsheet `player_profiles` enrichment table built by
`pipeline/build_profiles.py` from the Cricinfo sheet. Men-only in practice. Columns:
- `player_id`, `registry_name`, `full_name`, `country`, `dob`,
- `playing_role` (verbatim sheet role), `role_group` (Batter / Allrounder / Bowler; NULL
  for Unknown), `role_subgroup` (Wicketkeeper / Opening / Top-order / Middle-order /
  Batting allrounder / Bowling allrounder),
- `batting_style`, `bowling_style`, `bowling_arm` (Right / Left / NULL),
- `bowling_type` (Off-spin / Leg-spin / Slow left-arm orthodox / Left-arm wrist-spin /
  Slow-medium / Medium / Medium-fast / Fast-medium / Fast / NULL),
- `bowling_group` (Pace / Spin / NULL; bare "slow" = Spin per decision 15),
- `teams_played_for`, `headshot_url`, `has_real_headshot` (BOOL),
- `match_tier`, `sheet_player_id` (matching provenance).
- (No `career_*` columns — career features were shelved by the owner early in D-phase.)

**matches.parquet** — one row per match.
- `match_id`, `match_type` (T20 | IT20 | ODI | ODM | Test | MDM), `gender` (male | female),
  `team_type` (international | club), `match_date` (DATE = `match_date_1`), `year` (INT),
  `month` (INT), `venue`, `city`, `event_name`, `team_1`, `team_2`, `winner`, `result_type`

**batting_innings.parquet** — one row per crease appearance
(PK `match_id`, `innings_number`, `batter_id`). Includes 0-ball appearances (non-striker
or wicket-only rows / diamond ducks).
- Keys + denormalized context: `match_id`, `innings_number`, `batter_id`, `batter_name`,
  `batting_team`, `bowling_team`, `match_type`, `gender`, `team_type`, `match_date`,
  `year`, `month`
- Totals: `runs`, `balls_faced`, `dots`, `fours_hit`, `sixes_hit` (hit boundaries only,
  per §4.1), `dismissed` (0/1), `dismissal_kind` (nullable),
  `batting_position` (rank of first crease appearance; never NULL, 1–12)
- T20-family phase components: `pp_runs`, `pp_balls`, `mid_runs`, `mid_balls`,
  `death_runs`, `death_balls`
- ODI-family phase components (NULL for The Hundred): `odi_pp_runs`, `odi_pp_balls`,
  `odi_mid_runs`, `odi_mid_balls`, `odi_death_runs`, `odi_death_balls`
- Innings-progression buckets (faced-ball ordinal windows, all formats): `fb1_10_runs`,
  `fb1_10_balls`, `fb11_20_runs`, `fb11_20_balls`, `fb21p_runs`, `fb21p_balls`

**bowling_innings.parquet** — one row per (match_id, innings_number, bowler_id).
- Keys + denormalized context: `match_id`, `innings_number`, `bowler_id`, `bowler_name`,
  `bowling_team`, `batting_team`, `match_type`, `gender`, `team_type`, `match_date`,
  `year`, `month`
- Totals: `balls` (legal), `runs_conceded` (per §4.1), `wickets` (bowler-credited),
  `dots`, `fours_conceded`, `sixes_conceded` (off the bat, hit boundaries),
  `maidens`, `wides_runs`, `noball_runs`
- Wicket-type breakdown (six kinds, sum exactly to `wickets`): `wickets_bowled`,
  `wickets_lbw`, `wickets_caught`, `wickets_caught_and_bowled`, `wickets_stumped`,
  `wickets_hit_wicket`
- T20-family phase components: `pp_balls`, `pp_runs_conceded`, `pp_wickets`, `mid_balls`,
  `mid_runs_conceded`, `mid_wickets`, `death_balls`, `death_runs_conceded`, `death_wickets`
- ODI-family phase components (NULL for The Hundred): `odi_pp_balls`,
  `odi_pp_runs_conceded`, `odi_pp_wickets`, `odi_mid_balls`, `odi_mid_runs_conceded`,
  `odi_mid_wickets`, `odi_death_balls`, `odi_death_runs_conceded`, `odi_death_wickets`

**matchup_batting.parquet** — one row per
(PK `match_id`, `innings_number`, `batter_id`, `bowling_type`): the batter's record
against every distinct bowling style faced that innings, keyed by the **bowler's** mapped
style (`COALESCE(profile.bowling_type, profile.bowling_group, '(unmapped)')`). Men-only in
practice; the `(unmapped)` bucket makes an honest "N of M balls" coverage denominator
computable in the browser.
- Keys + context: `match_id`, `innings_number`, `batter_id`, `bowling_type`,
  `bowling_group`, `batter_name`, `batting_team`, `bowling_team`, `match_type`, `gender`,
  `team_type`, `match_date`, `year`, `month`
- Totals: `runs`, `balls_faced`, `dots`, `fours_hit`, `sixes_hit`, `dismissals`
  (bowler-credited kinds only, per decision 23)
- Dismissal-kind split (six, sum to `dismissals`): `dis_bowled`, `dis_lbw`, `dis_caught`,
  `dis_caught_and_bowled`, `dis_stumped`, `dis_hit_wicket`
- T20-family phase: `pp_runs`, `pp_balls`, `mid_runs`, `mid_balls`, `death_runs`,
  `death_balls`
- ODI-family phase (NULL for The Hundred): `odi_pp_runs`, `odi_pp_balls`, `odi_mid_runs`,
  `odi_mid_balls`, `odi_death_runs`, `odi_death_balls`
- `batting_position` (the batter's own position that innings; §4.1 definition)

**matchup_bowling.parquet** — one row per
(PK `match_id`, `innings_number`, `bowler_id`, `batting_hand`, `batting_position`): the
bowler's record against right- vs left-handers, split by the **striker's** batting
position, keyed by the batter's `batting_style` (`Right-hand bat` / `Left-hand bat` /
`(unmapped)`).
- Keys + context: `match_id`, `innings_number`, `bowler_id`, `batting_hand`,
  `batting_position`, `bowler_name`, `batting_team`, `bowling_team`, `match_type`,
  `gender`, `team_type`, `match_date`, `year`, `month`
- Totals: `balls`, `runs_conceded`, `wickets`, `dots`, `fours_conceded`, `sixes_conceded`
- Wicket-type split (six, sum to `wickets`): `wkt_bowled`, `wkt_lbw`, `wkt_caught`,
  `wkt_caught_and_bowled`, `wkt_stumped`, `wkt_hit_wicket`
- T20-family phase: `pp_balls`, `pp_runs_conceded`, `pp_wickets`, `mid_balls`,
  `mid_runs_conceded`, `mid_wickets`, `death_balls`, `death_runs_conceded`, `death_wickets`
- ODI-family phase (NULL for The Hundred): `odi_pp_balls`, `odi_pp_runs_conceded`,
  `odi_pp_wickets`, `odi_mid_balls`, `odi_mid_runs_conceded`, `odi_mid_wickets`,
  `odi_death_balls`, `odi_death_runs_conceded`, `odi_death_wickets`

**player_matches.parquet** — one row per (PK `match_id`, `player_id`): every player who
**played** a match (source `match_players`, completed with anyone who appears in
`deliveries`/`wickets` but is missing from the XI). Powers matches-played counts and the
"teams this player has played for" selector.
- `match_id`, `player_id`, `player_name`, `team`, `match_type`, `gender`, `team_type`,
  `match_date`, `year`, `month`

**Validation gates in `export_parquet.py` (the build FAILS loudly if any is violated):**
row count > 0 per file; no duplicate primary keys; batting `runs`/`balls_faced`, bowling
`runs_conceded`/`wickets`, and the matchup totals all reconcile to independent
`deliveries`/`wickets` reference sums; batting rows == independent crease-appearance
count; `batting_position` never NULL and within 1–12; The Hundred `odi_*` all NULL and its
phase splits sum to totals; wicket-type and dismissal-kind splits sum to their totals;
progression buckets sum to `balls_faced`/`runs`; matchup phase trios sum per T20/ODI rows;
a men's-T20-2024 coverage-scope identity; and vocabulary tripwires. A handful of
owner-verified career lines (`SPOT_CHECKS`) are asserted on every run.

### 4.3 GitHub Actions workflow (`pipeline.yml`)

One workflow, daily cron + manual dispatch, `concurrency`-guarded so two runs can never
clobber each other's R2 write. Sequential chain: download `cricket.duckdb` from R2 →
ingest new Cricsheet files (incremental, per-file transactions — ingestion logic is
frozen/validated, never "improved" without owner sign-off) → fetch the profiles sheet
from Dropbox (with last-good-copy fallback + owner alert emails) → rebuild the
`player_profiles` table inside the DB → upload the DB back to R2 → run
`export_parquet.py` and upload all 8 Parquet files **plus manifest.json LAST** (each data
file retried up to 3× with backoff; a failed data upload skips the manifest so the browser
never reads a manifest pointing at a missing object). Secrets (R2 keys, Dropbox URL, Gmail
alert credentials) live only in GitHub Actions secrets. The Parquet files are never
committed to git.

### 4.4 R2 serving requirements

- The `explorer/` prefix is publicly readable through the custom domain
  **`data.the-cordon.com`** (Cloudflare). Data files carry **immutable cache headers**
  (CDN edge caching); `manifest.json` is served so the browser can fetch it fresh.
- CORS allows GET + HEAD + Range from the app origins. **R2 CORS currently allows
  `localhost:8000` / `127.0.0.1:8000` and the Vercel production origin, but NOT Vercel
  preview domains** — so owner reviews happen on `localhost:8000` (see decision 27; this
  is deliberate and non-blocking).
- The site reads `manifest.json` first (cache-busted with `?t=Date.now()`, fetched
  `no-store`) and appends each file's `sha256_12` as a `?v=` query param to the Parquet
  URL, so browsers cache the data aggressively but always see fresh data after a pipeline
  run.

## 5. Frontend — Stats (leaderboard)

### 5.1 The scope strip

A slim always-visible strip carries the coarse scope. Its controls apply the moment they
change (they are not held behind Search — but the *table* only re-queries on Search, §5.5):

1. **Gender** — Men / Women, single-select. **Men is the default.** Switching gender
   clears any profile-based filter (profiles are men-only).
2. **Discipline** — Batting / Bowling. Lives in the scope strip (the header keeps only
   the Stats / Graphs view switcher).
3. **Format** — a multi-select checkbox dropdown over **three buckets**: **Red Ball**
   (Test + MDM), **50 Over** (ODI + ODM), **T20** (T20 + IT20). Tick one, two, or all
   three; there is no "Both/All" toggle (tick the boxes).
4. **Team type** — a multi-select of **International** / **Domestic** (the value `club` is
   displayed as "Domestic"; data unchanged). Independent of format.
5. **Date range** — FROM / TO date pickers.

Standing anchors (Men / T20 / International, 2023-07-01 → 2026-07-02): **2,813 players**;
Karanbir Singh **2,454** runs; SA Yadav **60 inns / 1,544 runs / 29.13 avg / 150.34 SR**.

### 5.2 Filters drawer, pills, and the "Search is the only trigger" rule

Everything finer than the scope strip lives in **one "Filters" drawer**: Team, the profile
filters (playing role, batting hand, R. Pos., bowling style, teams), striker batting
position (a plain multi-select dropdown), and the advanced stat-condition builder. The
drawer has a **single Apply**. Applied filters render as **removable pills** above the
table (named for their condition, e.g. "Runs ≥ 300"); the coverage/personal-data note is
right-aligned in the pill row.

**Search is the ONLY thing that queries the table** (owner rule, decision 25 + reaffirmed
through Rounds 3–5): the table is **blank on first load**, everything (dates, presets,
Vs, Columns, player search, filters, and column-header sort) is **pending** until the
Search button runs the query against the applied-state snapshot. Any scope/filter change
blanks the table back to the prompt, so numbers are never shown for a scope the filters no
longer describe. Instant exceptions (owner-ruled): once a result set exists, **sort,
column add/remove, and drag-reorder are instant**, and **picking a player from the
results search drops their row in immediately** (an added/searched player becomes a pin,
§5.5). Toolbar-only changes preserve row order; only a ranking Search or a header click
re-sorts (decisions 47g, 52). The Graph Builder is separate and auto-updates (§6), behind
its own "Apply to graph" gate.

### 5.3 Advanced stat conditions

An AND/OR condition builder: groups of conditions (metric, operator [≥, ≤, =, between],
value) combinable with AND/OR, applied to the computed metric values under the current
scope. **Numeric conditions are per-discipline** — they do not leak batting↔bowling —
while identity filters (role, teams) persist across the discipline toggle; **batting hand
does not persist into Bowling and is absent as a Bowling filter** (decision 54). "Matchup
(Vs)" is the first entry inside the advanced-metrics list. Best Bowling has a two-box
condition ("≥ W wickets for ≤ R runs"); High Score is a single-box condition. Minimum
innings is **not** a base filter — it is an ordinary advanced condition (decision 46c).

### 5.4 Metric catalogue (`src/metrics.js`)

Every metric is defined **once** in the shared `metrics.js` module as an object of the
shape `{key, label, discipline, source, sqlExpression, sortExpression?, higherIsBetter,
format, isPhaseMetric, kind, additive, zeroIsData, ...}`. Both the table and the graph
import this module; no metric is defined anywhere else. All metrics are computed in SQL
from the exported innings/matchup components — never from raw deliveries at runtime.

- `kind` ∈ **total | rate | percent | peak** classifies the metric for chart eligibility
  and for recombination across buckets (the Line chart requires total/rate/percent).
- `additive: true` marks metrics that can be summed (used to gate the donut and "Other"
  slice; e.g. High Score is not additive).
- `source` ∈ **innings | matchup | player_matches** names which export it reads.
- `isPhaseMetric` ∈ **t20 | odi | null** gates phase families to the right format scope.
- Division by zero in any ratio → **NULL** (never Infinity, never 0); NULL sorts last
  regardless of direction. This is the ONLY sample guard in the app (see §8.1).

Batting metrics include: innings, runs, balls faced, high score, batting average
(runs/dismissals), strike rate, balls per dismissal, dot %, boundary %, balls per
boundary, 4s, 6s, not-out %, phase strike rates (PP / middle / death, T20 and ODI
families), faced-ball progression strike rates (first-10 / 11–20 / 21+), plus the
dismissal-kind breakdown (six real kinds + a "show as %" toggle). Bowling metrics include:
innings, wickets, balls, runs conceded, bowling average, economy, bowling strike rate, dot
%, boundary % conceded, maidens, phase economy/wickets (PP / middle / death, T20 and ODI
families — the Middle economy/wickets pair was added in decision 58), best bowling, and
the wicket-type breakdown. Matchup metrics live in their own namespaces
(`matchup_batting` / `matchup_bowling`) and reuse the same keys where meaningful (e.g.
"average" under a Vs bucket is the ordinary Batting/Bowling Average, auto-scoped —
decision 57). Some matchup-only stats (Matches, High Score, Best Bowling) carry
`vsTableOnly` metadata but are graphable per decisions in Wave B.

**Note (dead metadata):** `minSampleComponent` and all sample-floor machinery were
**removed** (decision 49) — see §8.1.

### 5.5 Table behaviour

- **Columns** = the visible metric set, chosen via **one-click presets** (Core /
  Boundaries / Dismissals / Phases / Progression) and a **"Columns"** customiser (the
  control keeps the name "Columns" and never moves or vanishes, even in matchup mode).
  Sortable by any column, direction-aware (economy ascending = best). A filtered metric
  auto-adds its column.
- **Row grouping** — a small "Group rows" toolbar control (discipline-aware; dismissal
  grouping was cut, decision 42), off by default.
- **Pins** — a **pin column** left of the rank column (there is no pin pill anymore,
  decision 61): click to pin/unpin, pinned rows float to the top, a searched-in player is
  automatically a pin, and a pin with no innings in scope shows its in-scope record or
  "–" plus a "(no innings)" toast. Pins persist through toolbar-only changes and reset on
  a filters Search.
- **Matchup ("Vs") mode** — a "Vs" selector switches the table to per-bowling-style
  (batting) or per-batting-hand (bowling) splits, carrying the **full** filter set
  (team/opposition/event/venue/profile/R. Pos./pins/scope/search) into the matchup views
  (decision 47a). It has a restricted, matchup-vocabulary column picker (Coverage always
  available), a Vs-only striker-position filter, and per-group **composition columns**
  (e.g. batting Pace / Spin / Uncategorised balls-faced %, summing to 100% per row) that
  are ordinary sortable/toggleable columns. Coverage is stated honestly ("N of M balls,
  X%"); dismissals shown are bowler-credited only (decision 23). The Vs select is disabled
  for Women with an honest "no style data" note.
- Row-count indicator reflects the filtered set honestly; a subtle loading state during
  queries, never a frozen UI.

## 6. Frontend — Graphs (Graph Builder)

Same page (a view/panel, never an iframe — v1's iframe caching bug is banned). Chart.js is
vendored and deferred. The Graph Builder **shares the Stats filter store** and honours
matchup ("Vs") mode; it draws Vs numbers through the **same** query builders as the table,
so values are identical. The graph updates on its own **"Apply to graph"** gate — the
whole graph Filters popup is **fully staged**: discipline/gender/Vs/format edits stay in
the popup (they do not touch the shared Stats store) until Apply commits them atomically
and reseeds the roster (decision 55). Graphs carry **no defaults** — nothing auto-fills;
empty-with-guidance until inputs are given (decision 46f).

**Chart types — there are currently EIGHT** (`CHART_TYPES` in `src/graph/graph.js`):

1. **Bar** — rank players on one metric (2–15), leader on top, Bars⇄Dots lollipop toggle.
2. **Scatter** — two metrics mapped against each other (5–60), with median quadrant guides
   (the X and Y pickers exclude each other's choice).
3. **Radar** — player shape profiles as small multiples, one mini-radar per player
   (1–6; overlaid webs are banned by owner ruling).
4. **Grouped Bars** — one metric family across match phases side by side (2–8);
   format-gated. *(Internal key `phases`; the display label was renamed "Grouped Bars" in
   decision 42 / Round-6 #7.)*
5. **Slope** — one rate/percent metric across two explicit date windows (2–12); the two
   Window A/B date pickers start empty and must both be set.
6. **Line** — one metric plotted across a chosen **X dimension** (1–6 player lines). The
   X-axis dropdown offers **eleven** dimensions (`X_DIM_ORDER` in
   `src/graph/timeseries.js`): Innings (career sequence) · Date — month · Date — year ·
   Date — event/competition · Phase · Batting position · Vs bowling type · Opposition ·
   Venue · Innings of match (bat first / chase) · Match result. Missing buckets draw as
   gaps, never fake zeros; no sample floors. *(Internal key `byyear`; renamed from
   "By year" — the old year-only line was fully replaced, decisions 51 / 53.)*
7. **Dumbbell** — one matchup rate/percent metric across two sides drawn as a gap (2–12);
   Side A / Side B selects (default Pace vs Spin).
8. **Benchmark** — one anchor player vs the whole filtered pool, one row per metric grouped
   by kind (Volume / Tempo / Consistency); anchor = 100% reference line; the bar shows the
   best other player as a % of the anchor, switching to a "beaten" treatment when the
   anchor is passed.

> **Donut is NOT a Graph Builder type at present.** It was removed from the builder
> (`src/graph/graph.js` no longer imports or renders it); the `buildDonutChart` renderer
> is kept on-file, additive-only, for the **player-pop-up** donut and possible future
> reuse. Historical design docs and `reference/CHART_SYSTEM.md` still describe nine types
> including Donut — treat this section (and `CHART_TYPES`) as the current truth.

**Shared graph systems:** a **roster** control with a never-truncated candidate pool and a
checked subset ("N of M selected"); at a chart's player cap, unchecked rows disable with a
tooltip and are never silently dropped (switching to a larger type restores them); a
Manual / Best / Worst mode when the pool exceeds the cap; a player-search add box; and a
"Reset to full player set" control (greyed when the roster is already the full set). The
roster dropdown shows a per-chart **`[usable]`** chartability badge (green usable / red
not-usable) computed against the current chart type (decision 59/60). Selected players pin
to the top of the roster list. **Pins are managed via the pin column in Stats, not a pin
pill.** Auto-generated **honest** title / subtitle / footer state only the filters actually
applied (§8.3); an edited title survives roster changes but regenerates on a type/metric
change. Export is a 2× DOM snapshot → **Export PNG** + **Copy PNG**, both disabled while
the chart is "dirty" (pending control edits not yet drawn) and re-enabled after "Update
chart" (decision 61). Required-but-empty controls show a red **needs-input** outline.

Chart caps and full per-type behaviour are documented in `reference/CHART_SYSTEM.md`
(kept as the functional chart reference for brand/asset work; note its "nine types /
Donut" framing predates the donut removal).

## 7. Frontend — Player pop-ups

Clicking any player name (in the table or a chart) — or picking a player from the header's
global search — opens the profile as a **centred overlay** (full-screen on phones) over
the current view. It closes via ×, backdrop click, or Escape; the page behind is
untouched. There is no Players tab.

- **Header** — real headshot where `has_real_headshot` (≈1,360 players); everyone else
  (and all women, and unmatched men) gets a designed monogram medallion — never a broken
  image. `playing_role = "Unknown"` is suppressed in header lines.
- **Body** — a single-scroll layout with a **Batting | Bowling toggle**: overview cards
  (with the Test/MDM balls-per-dismissal swap), by-position table, vs-opposition table,
  the "How out" dismissal fingerprint (counts + % of dismissals + a not-out line),
  faced-ball progression cards; and for bowling, cards incl. best bowling, wicket-type
  bars, and matchups. Matchups appear in the pop-up too: batting "Vs pace and spin"
  (coarse) + "Vs bowling type" (fine, bare-slow bucket labelled "Spin (unspecified)"),
  bowling "Vs left- and right-handers", each leading with its coverage line.
- **Own scope drawer** — the pop-up has its own Filters drawer that **re-scopes the whole
  overlay** (Vs type, dates, positions, opposition); every section recomputes, with a pill
  row, an honest scope line, and reset. Note that leaderboard-only filters do not apply
  inside the pop-up.
- Blocks with no innings in scope show honest notes, never empty tables.

**Profiles are men-only.** On the Women view, every profile-powered surface (the profile
filter row, matchup sections, header profile fields) is greyed with an honest note —
e.g. "We don't have profile data on Women yet." — because 0% of women players have a
profile.

## 8. Non-negotiable engineering rules

### 8.1 NO DATA-POLICING (standing rule — reverses the old `hasMetricData` / sample-floor rule)

The app **shows all data**. There is **no** sample-floor fading, muting, greying, or
hiding; no minimum-sample thresholds; no "0/NULL never appears in charts" rule. Every
player and every value is plotted and listed however thin the sample. The **only** guard
is the divide-by-zero rule: a ratio with a zero denominator is **NULL** (never Infinity,
never 0) and sorts last. All prior thin-sample machinery (`hasMetricData` as a
suppression predicate, `minSampleComponent`, `MIN_BALLS_PER_YEAR`, by-year point fading)
has been removed. (Owner decision 49: "user's prerogative — provide optionality, don't
control for the user; don't assume the user needs parental controls." This reverses the
earlier decisions 44c / 45 / 46e / 44e.)

### 8.2 One metrics module

`src/metrics.js` is the single source of every metric (§5.4). Duplicated metric
vocabularies across files (v1's fragilest seam) are banned. The table, the graph, the
pop-up, and the pipeline-adjacent labels all read from it (chart labels route through
`metricDisplayLabel` so they cannot diverge).

### 8.3 Honest descriptions

Titles, subtitles, and footers (in charts and scope lines) may only claim filters that are
actually applied, and only what is actually drawn. Coverage lines state real denominators
("Style data covers 913 of 1,027 balls faced (88.9%)"). Empty results must state their
reason.

### 8.4 No secrets in the repo

No secrets are committed. R2 keys, the Dropbox URL, and Gmail alert credentials live only
in GitHub Actions secrets. (The Supabase anon key, if/when the feedback form is built, is
public by design — RLS is the boundary; see §9.)

### 8.5 Modular code

ES modules, no framework, no build step. The intended guideline is **no file over ~600
lines**, with a layout like `src/db.js`, `src/metrics.js`, `src/filters.js`, `src/table.js`,
`src/state.js`, `src/graph/*.js`, `src/playerData.js` / `src/playerSections.js`, `styles.css`,
`index.html`. **Reality note:** several files (notably `src/table.js`, `src/graph/graph.js`,
`src/metrics.js`, `styles.css`, and `src/graph/charts.js`) now exceed ~600 lines; the
file-split is a **deferred** hygiene item, not a live requirement.

### 8.6 Mobile-usable

Filters, table, charts, and pop-ups work at a phone viewport (~375px). The table may
scroll horizontally; wide charts pan **inside** the chart box (the page never scrolls
sideways) and export at fixed canonical sizes (screen == export).

### 8.7 Design

Distinctive editorial look (north star: Guardian player guides), generous whitespace, no
default-Bootstrap feel. The functional chart/brand contract lives in
`reference/CHART_SYSTEM.md`. The footer "debug console" link is removed from production
(decision 43).

## 9. Feedback form (Supabase RLS) — NOT built

A small feedback form (comment, optional name/email) writing to a `feedback` table in a
Supabase project **with RLS enabled** (anon role may INSERT into `feedback` only; no
SELECT/UPDATE/DELETE; no access to any other table) remains a **pending polish item** — it
has not been built. The anon key would be public by design; RLS is the security boundary.
Provide the exact RLS policy SQL in the README when it is built.

## 10. Authoritative record of behaviour

This spec is a reference, not the ledger. The authoritative, dated record of every owner
ruling is **`review/owner_decisions.md`** (the ONLY decision log); the wave-by-wave build
status and per-round history are in **`.orchestrator/design-plan.md`**. Product/data
detail also lives in `SPEC_ADDENDUM_DATA.md` (D-phase data expansion) and
`reference/db_reference.md` (database schema). If this spec conflicts with the decision
log, the decision log wins — and the conflict should be reported, not silently resolved.

## 11. Testing & verification rules

- Every SQL aggregate in `export_parquet.py` reconciles to an independent `deliveries`
  reference sum via a build gate, plus owner-verified `SPOT_CHECKS` (see §4.2). The build
  fails loudly on any gate breach.
- Number-adjacent frontend changes get an **independent hand-written DuckDB check**
  (`import('/src/db.js').then(m => m.query('SELECT …'))`) — never reusing the app's own
  aggregation shape to verify itself (standing rule from decision 39). The standing anchors
  in §5.1 (and the matchup anchors: Bumrah vs RHB pos 1–2 = 27/177/9; SA Yadav vs Spin =
  38/454/SR 140.99, coverage 913 of 1,027) must reproduce.
- Reviews run on **`http://localhost:8000`** (`python3 -m http.server 8000`); R2 CORS
  allows only `localhost:8000` / `127.0.0.1:8000` (and Vercel production), so no other
  port/host loads data. Browsers cache ES modules hard — cache-reload each changed file
  after editing.
- `node --check` every touched `.js`; boot with **zero console errors**; reproduce the
  anchors on screen. Never mark work done with failing verification.

## 12. Open / pending items

- **Feedback form** (Supabase RLS) — not built (§9).
- **Team & venue pop-ups** — not built (player pop-ups only, so far).
- **Team + opposition name normalization** — the first post-round to-do (club/domestic
  opposition currently runs on raw team names, decision 51).
- **Per-over Line X-dimension** — needs a test-first pipeline data extension; parked by the
  owner (decision 51 / BACKLOG).
- **L3 v1 extras** — glossary tooltips, per-chart "how to read", CSV export of the table,
  click-to-highlight, and a "Randomise" archetype engine — all wanted, deferred
  (decision 46g).
- **File-split hygiene** — the ~600-line files noted in §8.5.
- **Vercel preview CORS**, headshots beyond the pop-up, and career-compare mode — deferred.

## 13. Open questions for the owner (ask, do not assume)

Per the working style, any cricket-logic ambiguity not covered by §4.1 or the decision log
must be raised with the owner rather than guessed.
