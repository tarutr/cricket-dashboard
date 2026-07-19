# cricdb — Design Round 5 handoff (23-item review batch + Line redesign)

> **READ THIS FIRST, then `CLAUDE.md` (repo root), `.orchestrator/ORCHESTRATION.md`, and
> `review/owner_decisions.md`.** You are continuing an in-flight, gated design round in a FRESH chat
> with no memory of the prior conversation. Everything needed is here or in the files this points to.
> Run as the **Opus 4.8 orchestrator** (`/opus-orchestrator`): decompose, delegate to right-sized
> subagents (model+effort per spawn), verify every result yourself in-browser, commit per wave, and
> **STOP for the owner's go between waves.** Owner is **non-technical**: report in plain English, name
> the control and what changed, never raw diffs.

## The two supreme rules (full text in CLAUDE.md)
1. **Numbers are sacred.** You change only WHEN/HOW things display, never WHAT a query returns, unless
   a task explicitly authorises a query change. `buildQuery`/`buildMatchupQuery` (`src/table.js`),
   `buildScopeClauses`/`buildCoreScopeClauses` (`src/filters.js`) stay byte-identical otherwise. If an
   anchor moves, you touched calc logic → revert.
2. **Owner decisions are law; take instructions literally.** Never narrow OR extend. Build exactly
   what's specified; flag adjacent ideas as questions, never silent additions. This round has
   repeatedly burned on over/under-scoping AND on giving shallow/dismissive answers — **reproduce in
   the running app and read the code before you claim anything; do not theorise.**

## THIRD standing rule established THIS round — NO DATA-POLICING
**Strip and never re-add sample-floor fading / muting / greying / "thin-sample" controls.** If a user
picks a chart/metric with tiny samples (a strike rate off 3 balls, a one-innings dot), PLOT IT AS-IS.
The owner: "it's the user's prerogative — provide optionality, don't control for the user; don't
assume the user is an idiot that needs parental controls." Keep ONLY `NULLIF(…,0)` divide-by-zero
guards (they prevent errors, not police data). Reverses decisions 44c/45/46e/44e — but see "Fading
reality" below: most were ALREADY removed; little work remains.

## Standing anchors — re-derive EVERY wave (scope Men / T20[+IT20] / International, 2023-07-01→2026-07-02)
- Batting baseline **2,813 players**; top row Karanbir Singh **2,454** runs.
- SA Yadav **60 inns / 1,544 runs / 29.13 avg / 150.34 SR**.
- SA Yadav **vs Spin = 38 inns / 454 runs / SR 140.99** (coverage 913 of 1,027).
- Bumrah **vs RHB at striker positions 1,2 = 27 inns / 177 balls / 9 wkts**.
- Plain query fingerprint (djb2, standard all-filters plain state): **3307620867 / len 1430**.
- "T20" scope = `match_type IN ('T20','IT20')` via `expandFormats` — a naive single-'T20' check reads 2,810.

## HOW TO VERIFY (harness gotchas — these cost hours if unknown)
- Serve on **localhost:8000** (`python3 -m http.server 8000`); R2 CORS allows only that host.
- After editing modules: `await Promise.all([...].map(f=>fetch(f,{cache:'reload'})))` for each changed
  file **then navigate/reload** — `import()` returns stale modules otherwise. 0×0 pane → resize 1280×800.
- Console DuckDB: `import('/src/db.js').then(m=>m.query('SELECT …'))`; **`query()` returns `{rows, ms}`**
  (use `.rows`); SUM → BigInt, wrap in `Number()`. Reserved words `out`/`rows` must be aliased.
- **`buildQuery(state, cols)` IS exported** from table.js and auto-dispatches to the unexported
  `buildMatchupQuery` when `matchupVsActive(state)`. `fetchSelectedPlayerMetrics` (charts.js) is exported.
  `createInitialState()` defaults to Men/Batting/T20/International (just set dateFrom/dateTo).
- Scope clause for independent hand-checks: `gender='male' AND match_type IN ('T20','IT20') AND
  team_type='international' AND match_date BETWEEN DATE '2023-07-01' AND DATE '2026-07-02'`.
  **`team_type` values are lowercase** (`'international'`, `'club'`). matchup_batting.bowling_group ∈
  {Pace, Spin, (unmapped)}; matchup_bowling.batting_hand ∈ {Left-hand bat, Right-hand bat, (unmapped)}.
  SA Yadav batter_id=`271f83cd`; JJ Bumrah bowler_id=`462411b3`. matchupVs shape = `{dim:"group"|"type"|"hand", value}`.
- To reach matchup mode in the UI: set From+To dates, Search (plain first), then pick a Vs bucket.
- The custom `searchSelect` control resists synthetic clicks under browser automation — drive it by
  dispatching `click` on the actual `.search-select__option` elements; give it ~1s to load options.
- Cheapest correctness guard: if a change doesn't touch table.js/filters.js/metrics.js aggregation,
  anchors are byte-identical by construction — confirm via `git diff` and move on.

## Branch / commit state
Branch **`polish-b1-mechanical`** (main untouched; merging is a separate owner decision). Round 4
(below) is fully committed here. Round-4 owner review checklist: `review/DESIGN_ROUND4_REVIEW_CHECKLIST.md`.

---

## PART A — DONE before this round (Round 4, committed, owner said "looks good")
Waves A (Matchup-Vs rename+placement, Best-Bowling two-box condition, High-Score-as-Vs-condition,
format-aware "(Innings)" label), C (Keep-Columns toggle, no-data pin, graph reset rename, A9 option-list
scoping to full conditions, popup searchSelect conversion, dead-CSS cleanup, extend vocab-clear to
format/date), and B (matchup-aware Graph: every standard chart type + Line-by-year plot Vs metrics with
table-identical numbers; the four vsTableOnly stats made graphable). All orchestrator-verified +
fresh-eyes reviewed (no blockers). **Round 5 (this handoff) REVISES several of these — notably Line and
the four Vs stats — see below.**

## PART B — INVESTIGATION VERDICTS (done this round; do NOT re-investigate — build on these)
Reproduced in the running app + read from code. Trust these:
- **Handedness filter is CORRECT (not a bug).** The batter batting-hand profile filter returns ONLY
  profiled batters — plain: hand=Left → 415 rows, all Left-hand; matchup: 369, all Left; it's an
  `IN (SELECT player_id FROM profiles WHERE batting_style=…)` semi-join (`state.js:81-100`), so it
  cannot return unknown-handed players. Unknown-handed players legitimately appear ONLY via (a) the
  **Vs=right/left-handers BOWLING matchup** (rows are BOWLERS; "hand" = the BATTER FACED per delivery,
  `matchup_bowling.batting_hand`, `table.js:301`; 228 of 2,029 such bowlers have no profile — correct),
  and (b) **pinned/added players**, which bypass narrowing filters by design (decision 46a;
  `whereWithPinExemption`/`gateWithPinExemption`, `filters.js:272-292`). Item #3's pinned-row marking
  makes (b) unambiguous. NO filter fix needed.
- **Men personal-data coverage:** 71.1% of all 9,986 men have a `profiles` row (batting hand 71.0%,
  bowling type 60.3%, playing role 37.2%); **88.6% inside the default men/T20/international scope**.
  Women = 0%.
- **"Runs per Innings" ≠ batting average.** average = `SUM(runs)/NULLIF(SUM(dismissed),0)` (metrics.js
  ~174); RPI = `SUM(runs)/NULLIF(COUNT(*),0)` (metrics.js:254) — differ by not-outs. No two metrics in
  the catalogue compute the identical expression (audited). But owner rules RPI unauthorised → remove (#20).
- **Club/domestic team names are un-normalized.** 276 distinct club names; one BPL franchise spans up to
  7 labels (Dhaka Capitals/Dominators/Dynamites/Gladiators/Platoon/Durdanto/Minister Group), IPL rebrands
  (Delhi Daredevils→Capitals), spelling variants (Comilla/Cumilla, Barisal/Barishal). Team AND opposition
  both run on these raw names — see #14.
- **Conditions vs columns storage (root of #7):** columns are per-discipline (`state.columns.batting/
  .bowling`, state.js:348); conditions are ONE shared list (`state.advanced`, state.js:354). A bowling
  condition sits in the list when you switch to batting; at query time it's silently skipped
  (`conditionToHaving` returns null when the metric key doesn't exist in the discipline) so numbers were
  never wrong, but it still renders as a live pill/drawer row.
- **Line was year-only (root of #21):** `buildTimeseriesQuery` (timeseries.js) buckets ONLY by calendar
  year, so a <2-year window yields <2 points → no line. Redefined below.
- **Graph "(Innings)" divergence (#23):** the filter DRAWER is ONE shared component
  (`mountFilterDrawer`, mounted at main.js:509 AND graph.js:1964) — already identical in both. The stray
  "(Innings)" comes from the graph's SEPARATE chart-metric picker (`graph.js` ~1028 + ~6 sites) using raw
  `m.label` instead of `metricDisplayLabel`. Route those ~6 sites through `metricDisplayLabel(m, state.formats)`.
- **Fading reality:** table rate-value muting (`SAMPLE_FLOORS`/`sampleFloorFor`) and benchmark floors
  are ALREADY REMOVED (benchmark.js:34; table.js:984; graph.js:2415 "no sample floors anymore"). Only
  `MIN_BALLS_PER_YEAR=30` (timeseries.js:112) remains — and it dies with the Line redesign.
  `minSampleComponent` still sits on metric defs but has NO consumer → dead metadata to delete.
- **Toolbar dates ALWAYS match popup dates** — both bind the same `state.dateFrom/dateTo`, synced both
  ways (table.js:1214, 1354-1368). No divergence possible.

---

## PART C — THE WORK: 23 owner items + exact resolutions (grouped into build waves)

### Wave R5-A — interaction rules & regressions (frontend/Opus-high; owns table.js/main.js/pills.js/drawer.js/drawerInnings.js/state.js/timeseries.js/styles.css)
- **#1 Remove ALL toolbar note text** — both "Matchup mode" and the "N of M stat conditions apply" line
  (`table.js:2009`). The toolbar already carries scope (dates/Vs/preset). (With #7 done, nothing is ever
  inert, so the "N of M" honesty note is moot.)
- **#9 Filters popup fully STAGED** — nothing below the toolbar (table rows OR pills) changes until the
  popup's Search is pressed. **Pills render from APPLIED state only.** This REVERSES Wave 4a's "pills
  reflect pending." (Owner was emphatic: the High-Score pill leaking onto the table mid-edit is wrong.)
- **#4 No table reorder on a toolbar-only change** — switching Vs / a column / preset must PRESERVE the
  current row order (players keep their positions, values swap; players that no longer qualify drop out;
  new qualifiers append at the BOTTOM). Order changes ONLY on a column-header click or a popup Search.
  (Today every commit re-sorts by the active sort key, so a Vs switch reshuffles everyone.)
- **#5 "Matchup (Vs)" = first entry INSIDE the "Advanced metrics" group** (immediately above Dot Ball %),
  NOT a standalone entry above the optgroups (current: `drawer.js:530-534`). basic/advanced split =
  `advanced.js:171` `BASIC_METRIC_KEYS`.
- **#8 Separate the striker "Batting position" from R.Pos.** Today the matchup striker-position picker is
  physically co-located inside the R.Pos row and un-hides whenever `matchupVsActive` (drawerInnings.js:116,
  drawer.js:553-555) — so picking Vs=Spin makes a 2nd "Batting position" dropdown appear inside the R.Pos
  row (reproduced: 1 dropdown before Spin, 2 after). Make the striker Batting-position its OWN addable
  condition, never auto-shown.
- **#10 Grey out "Keep Selected Columns"** when the pending discipline differs from the last-searched
  discipline, AND on a blank table (no search yet) — it's not a valid option there.
- **#7 Conditions become per-discipline (like columns).** Numeric stat conditions stored per discipline
  (`state.advanced.batting`/`.bowling`) so a bowling condition never leaks into batting and vice-versa
  (switch batting → see batting conditions; switch back → bowling ones intact). **Player-IDENTITY filters
  PERSIST across the toggle** (owner ruling #15): playing role, batting hand, bowling style, teams-played-for
  — those are facts about the person, identical in both disciplines. Everything numeric is per-discipline.
- **#15 Force picker label+options resync on any scope change** — Team/Against/Event/Venue (searchSelect)
  don't live-refresh their summary/options when state clears while the panel is open/mid-interaction (the
  multiselect defers refresh); the stale name lingers until clicked. State was always correct; only the
  display lagged. Same fix covers the "persist-metrics look stale on format change" report.
- Housekeeping folded here: delete the dead `minSampleComponent` metadata; remove `MIN_BALLS_PER_YEAR`
  (also handled by R5-D). NUMBER-CHECK: this wave is display/state only — anchors byte-identical.

### Wave R5-B — the pin system (frontend/Opus-high; owns table.js/main.js/pills.js/state.js/styles.css)
- **#3 Pin checkbox column** left of the `#` column (pin icon): click to pin/unpin a player. **Pinned
  players float to the TOP of the table.** Pins **reset on a filters-popup-applied change**, **persist
  through a toolbar-only change**. A pinned player with no data in the current slice shows **"–"** in every
  cell. (Pin state/exemption plumbing already exists: `state.pinnedPlayers`, `whereWithPinExemption`/
  `gateWithPinExemption` — today it's pill-only and never affects row order.)
- **#2 Searching an existing player lifts them to the top** — same behaviour as a pin (today it adds a
  pill but leaves the row wherever it ranked). Fold into #3's float-to-top.
- **#11 No-data pin shows in-scope data (the SA Yadav case).** A searched/pinned player excluded by
  personal filters but present for date/Vs → added + pinned at top, showing their in-scope record; "–"
  only where genuinely none. (Reproduced: bowling + Vs=Left-handers, SA Yadav legitimately had 1 inns /
  4 balls vs LHB and WAS in the results at rank 1,188 of 1,660 — invisible below the fold, no "(no
  innings)" because he genuinely had an innings. Pin-float makes it visible.)
- **#6 A filtered metric auto-adds its column** on popup Search if not already visible (e.g. a Best-Bowling
  filter → BBI column appears, so the table ranks by it instead of an unrelated default). Removable via Columns.
- **#12 Mark pinned rows visibly** (the pin column does this) so an out-of-filter added player can never be
  mistaken for a filter "leak." NO handedness filter change (Part B verdict: it's correct).
- NUMBER-CHECK: pin float/reset is display; the pin-exemption query already exists and is anchor-safe.

### Wave R5-C — graph cleanup (frontend-heavy/Opus; owns graph/graph.js/charts.js/benchmark.js + metrics.js for #20 removal + pills.js/state.js/styles.css for #18)
- **#22 Remove Best Bowling from ALL graph metric pickers** (plain + Vs). Table column + two-box filter
  STAY. (Reverses Round-4's "make Best Bowling graphable"; the rank-axis + "W-R" labels go.)
- **#23 Route the graph's chart-metric labels through `metricDisplayLabel(m, state.formats)`** (~6 sites
  in graph.js incl. ~1028, plus chart titles/axes/tooltips in charts.js that use raw `metric.label`). Then
  the graph can never show "(Innings)" when the drawer doesn't. import `metricDisplayLabel` into graph.js/charts.js.
- **#13 Graph reset link:** rename **"Reset to full player set"**; grey/unclickable when the roster already
  equals the full filtered set; box it visually WITH the "x of x selected" dropdown so the link's target is
  obvious. (`graph.js:400`.)
- **#19 Graph validation everywhere.** Today `needs-input` red-outline is applied ONLY to slope/dumbbell
  date-window boxes (`syncWindowNeedsInput`, graph.js:1078-1083); the chart-type + metric pickers get only a
  stage-guidance SENTENCE, on Update. **Red-outline EVERY empty required control** (chart type, each metric
  picker, radar/benchmark metric lists) + show its naming message ("Choose a chart type", "Pick a metric").
  Each type's `needs` text already exists (`CHART_RULES`, graph.js:82-121).
- **#20 Remove "Runs per Innings" ENTIRELY** — plain (metrics.js:254) + matchup (metrics.js:984) defs and
  all refs (advanced.js, graph.js, benchmark.js): metric catalogue, "+ Add condition" list, column picker,
  every graph picker. Confirm no anchor moves (RPI is not an anchor; not in DEFAULT_COLUMNS).
- **#18 Personal-data coverage note, right-aligned in the pills row.** REMOVE the separate "Matchup mode"
  note row (aesthetic, owner). Any note that stays (the coverage note — see Part B: ~89% in default scope,
  71% overall for men) sits right-aligned WITHIN the pills row, separate from the pills.

### Wave R5-D — Line graph full redesign (data-engineer + frontend / Opus-xhigh; number-adjacent; owns graph/timeseries.js/timeseriesChart.js/graph.js/charts.js)
Redefine Line completely. **Line = one Y-metric × one X-dimension × up to N player lines (cap 6–8, exact
number decided by the owner on sight).** X is a DIMENSION (not a metric) → no same-axis collision. Two
dropdowns: **"X axis"** and **"Metric" (Y)**. **NO fading/floors on any point — plot everything, however
thin the sample.**
- **X dimensions (ALL built this wave — no phased subset; owner: "why can't we have it all"):**
  **Innings** (index 1,2,3…; align players by their OWN sequence — player A's 5th sits under player B's 5th,
  regardless of date; dates only decide which innings are in the pool), **Date (month)**, **Date (year)**,
  **Date (event)**, **Phase** (Powerplay/Middle/Death — a phase LINE, distinct from the Phases BAR chart),
  **Batting position** (1→11), **Vs bowling type** (Pace/Spin + fine types), **Opposition** (each team),
  **Venue** (each ground), **Innings-of-match** (bat first vs chasing = innings_number 1/2), **Match result**
  (won/lost).
- **Y** = any value metric. Aggregation per X-bucket = the app's normal math: totals SUM, rates RECOMBINE
  (e.g. SR per year = year runs ÷ year balls). For X=Innings each bucket is ONE innings → Y = that innings'
  value (no aggregation).
- Sequential X (innings/position/month/year/phase) draws as a trajectory; categorical X (opposition/venue/
  event/bowling-type/result) is ordered chronologically or by value and reads as a profile; a player missing
  a bucket → gap (line skips).
- Replaces the by-year concept entirely; `MIN_BALLS_PER_YEAR` deleted.
- NUMBER-ADJACENT: per-bucket aggregation is new query shaping. Reuse the existing metric sqlExpressions;
  verify charted values against independent hand-written DuckDB per X-dimension; non-Line charts + anchors
  byte-identical.

### Wave R5-E — per-over pipeline extension THEN per-over X option (data-engineer/Opus-xhigh; pipeline + then graph)
Owner: "let's do per over." The browser loads AGGREGATED parquets (per-innings + phase + matchup buckets);
they have NO per-over/ball-level rows. So per-over as a Line X-dimension needs a PIPELINE data extension to
emit per-over aggregates (the same additive, test-first, gated pattern as the decision-36 phase/matchup
column extension: write `pipeline/dev_test_*.py` verifying read-only vs the local DB, add permanent
reconciliation gates, cherry-pick to main as additive data, green run publishes to R2). Then per-over
becomes an X-dimension in Line (over 1→20, Y aggregated per over). Sequence AFTER R5-D lands. Cricket-
correctness-critical SQL → data-engineer, independent delivery-level verification.

### Wave R5-F — club opposition + player-popup drawer tidy (frontend/Sonnet-high; owns drawerInnings.js/playerData.js + playerFilters.js/styles.css)
- **#14 Enable club/domestic opposition NOW on raw team names** — consistent with how the Team filter
  already works (both currently run on the 276 un-normalized names). Owner accepted the incompleteness for
  now; **team-name normalization (fixing Team AND Opposition together) is a POST-ROUND to-do**, not this
  round. (Opposition was international-only per decision 20; owner reverses that gate for this round.)
- **#16 Tidy the player-popup filters drawer** (`playerFilters.js`) to the main drawer's density —
  narrower controls, grid layout, same spacing tokens. Boxes are currently too wide/wasteful.

### #17 — NO CHANGE (explain only)
Bowling-style-as-a-batting-filter is INTENTIONAL and code-documented (drawer.js:107-109) — it filters
batters by their own bowling identity ("how do leg-spinners bat"). Only R.Pos is discipline-gated. Leave it
unless the owner explicitly says remove (one line: drop "bowling" from `PLAYER_ADD_ORDER`, drawer.js:111).

### Scatter (from the Line discussion) — small fix, fold into R5-C or R5-D
The two Scatter axis dropdowns must **exclude each other's current pick** (no metric-vs-itself diagonal).
This is axis-validity, NOT data-policing.

---

## Phase gates (STOP points)
- Confirm you're oriented first: reproduce the **2,813 baseline on screen** before building.
- Each wave (R5-A … R5-F): verify each item + the anchors yourself in-browser, commit, **STOP for the
  owner's go** before the next wave.
- **R5-D Line:** at its start, present the two-dropdown model + the X-dimension list + how each X aggregates,
  for a quick owner check before building (it's the biggest, number-adjacent piece).
- **R5-E per-over:** it's a pipeline/data-layer change — get explicit owner go for the pipeline run, and
  follow the test-first/gated pattern; NEVER touch ingestion logic.
- Merging `polish-b1-mechanical` → main is always a separate owner decision.

## Definition of done (per wave)
- `node --check` every touched .js; boot localhost:8000 with **zero console errors**; the standing anchors
  reproduce EXACTLY on screen; number-adjacent waves (R5-D, R5-E, #6, #20) get an independent hand-written
  DuckDB check (never reuse the app's aggregation shape).
- Owner reviews each wave on localhost and signs off.

## Non-goals / deferred (do NOT do unless owner raises)
- **Team-name normalization** (Team + Opposition alias map) — queued as the FIRST post-round to-do.
- Merge to main.
- Removing bowling-style-as-batting-filter (#17) — intentional; leave unless owner says.
- Older deferrals still open: ~375px mobile one-screen fit; export-while-dirty.

## Open questions for the owner (ask upfront, consolidated)
- **Line cap:** 6–8 approved as a range; owner will pick the exact number after seeing it — default 6, show it.
- Anything genuinely blocked mid-wave → one consolidated question, not a drip.

## Decomposition hints (revisable)
- R5-A, R5-B both heavily touch table.js/main.js/pills.js → **serialize** (A then B). R5-C (graph) is
  disjoint from A/B → can run in parallel with them. R5-F (drawerInnings/playerFilters) disjoint → parallel.
  R5-D (Line) touches graph/timeseries — after R5-C's graph edits or coordinate file ownership. R5-E after R5-D.
- Routing: interaction/pin/graph-cleanup = frontend or frontend-heavy (Opus, number-adjacent bits xhigh);
  Line + per-over = data-engineer (Opus/xhigh, cricket SQL); popup-tidy/opposition-enable = frontend (Sonnet).
- Every brief carries the scope check (built exactly what was asked; deltas called out; no "for consistency"
  additions) and checkpoint discipline (wip: commits + `.orchestrator/progress/<task>.md` notes).

## Pointers (do not duplicate — read the source)
- Contract + anchors: **`CLAUDE.md`**. Orchestration: **`.orchestrator/ORCHESTRATION.md`**. Decision log
  (authoritative): **`review/owner_decisions.md`** (Round-5 rulings appended as decisions 49+). Status board:
  **`.orchestrator/design-plan.md`**; per-wave notes in `.orchestrator/progress/`.
- Cricket calc law: `SPEC.md` §4.1. Data schema: `reference/db_reference.md` (source DB) — the R2 parquet
  views are `batting`/`bowling`/`matchup_batting`/`matchup_bowling`/`matches`/`players`/`player_matches`/`profiles`.
- Key files: filter drawer `src/drawer.js` + `src/drawerInnings.js`; conditions `src/advanced.js` +
  `src/table.js conditionToHaving`; metrics `src/metrics.js` (+ `metricDisplayLabel`); scope
  `src/filters.js`; state `src/state.js`; graph `src/graph/graph.js`/`charts.js`/`timeseries.js`/
  `benchmark.js`/`phaseFamilies.js`; player popup `src/playerFilters.js`/`playerData.js`/`playerSections.js`.
