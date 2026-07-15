# Plan: Fix-round v2 — filter re-architecture + graph/table/popup fixes

Branch: `polish-b1-mechanical` (main untouched; owner gates the merge).
Owner verdicts: `review/design_round_2_decisions.md` + this session's answers.
Screenshots: `review/FIX_ROUND_SCREENSHOTS/`.

## Definition of done (verification plan)
- Every touched `.js` passes `node --check`.
- App boots on localhost:8000 with zero console errors (orchestrator checks each wave).
- **Anchors reproduce** on-screen AND via DuckDB CLI wherever query code was touched
  (F1a must NOT change query builders or the store's scope schema, only the UI + the
  when-to-query trigger — so anchors stay put by construction):
  baselines 2,813 batting / 2,049 bowling; SA Yadav men's T20I Jul23–Jul26
  60 inns/1,544/29.13/150.34, vs Spin 38/454/140.99 + coverage 913 of 1,027;
  Bumrah vs RHB pos 1–2 27/177/9; R.Pos=3 → 282, women R.Pos=3 → 177.
  (DuckDB-WASM SUMs are BigInt → Number() before comparing.)
- Each numbered owner point visually verified in-browser with a screenshot before commit.

## Core design principle
F1a changes **the filter UI and WHEN a query runs**, never the store's scope keys
(gender/discipline/formats/dateFrom/dateTo/teamType stay) and never the query
builders. That keeps numbers identical and decouples the graph/popup/table packages
from the filter re-architecture.

## Architecture decisions (owner-confirmed)
- No scope strip. ALL filters live in a **Filters popup** (modal), 3 collapsible sections:
  **Conditions** (Gender[Men left/Women right], Discipline, Format, Date range, Team type)
  → **Player** (Team current/historic, Role, Batting hand, R. Pos., Bowling style)
  → **Advanced Filters** (numeric conditions + Against-opposition as one condition row).
- "Apply and show results" → **"Search"**. Touching a control never blanks the table;
  only Search re-queries. Table persists until next Search (replaces) or Clear (empties).
  Gender lives in the popup → each Search is fresh; NO cross-gender table memory.
- **Clear** button in toolbar, right of Graph & Columns, red-tinted, empties the table.
- Subtitle is the only always-visible scope indicator (already mirrors scope).
- Dumbbell = Slope's data (one metric, two time windows) drawn as dumbbells; batting+bowling.

## Tasks
| # | Task | Owner files | Model/Effort | Depends on | Status |
|---|------|-------------|--------------|------------|--------|
| E | Inventory: scope-strip render/wire points, table.js toolbar hooks, styles.css region map, graph entry + back-link removal spot, muting-code locations (table/metrics/benchmark), search wiring | read-only | Haiku/med | — | pending |
| F1a[DONE 28123cb, verified] | State + interaction contract + Filters-popup shell; remove scope strip from page. Store scope keys UNCHANGED; Search = the one query trigger; table persists; Clear empties; no cross-gender memory; subtitle from applied scope. | state.js, main.js, index.html (scope-strip removal + popup shell), filter/popup-shell CSS | **Opus/xhigh** | E | pending |
| F1b | Populate popup: Conditions controls (Men left/Women right), compact Player profile (fix player_profile.png), Team dual-dropdown w/ popover-overflow fix (fix team_dropdown.png), opposition→Advanced-Filters condition (kill standalone dropdown + old Advanced section), women message "No bowling type data for Women available yet." | filters.js, drawer.js, drawerInnings.js, advanced.js, pills.js, popup-content CSS | Opus/high | F1a | pending |
| F2 | Toolbar: Filters button; Clear button (red, right of Graph/Columns); remove Vs dropdown entirely on Women; move table-search INPUT into toolbar; pills row BETWEEN toolbar and table (above column headers) | table.js (toolbar region), main.js (search input mount), index.html (toolbar), toolbar/table CSS | Sonnet/high | F1b | pending |
| G1 | Debug+fix **Line** (only 1 line draws) and **Slope** (0 players/empty); **rebuild Dumbbell** as time-window (Window A/B like Slope) for batting AND bowling | src/graph/timeseries*.js, charts.js, dumbbell*.js, graph.js (chart plumbing), graph CSS | **Opus/xhigh** | E | pending |
| G2 | Remove ALL default selections in Graphs; chart-type click no longer auto-fills; "Recommended" only after a metric is chosen; metric persists ACROSS chart types (invalid-for-type → message, no graph); restore "← Back to your table"; remove benchmark.js muting reuse | graph.js, card.js, benchmark.js, players.js, graph CSS | Sonnet/high (→Opus if fails) | G1 | pending |
| P | Popup: matchups grouped all-Pace-then-all-Spin w/ "Pace"/"Spin" subheadings; "Graph this player" visible but INERT | playerSections.js, playerData.js, playerFilters.js, playerPopup.js, playerGraphChooser.js, player-popup CSS | Sonnet/high | E | pending |
| T1 | Remove ALL sample-muting (no floors, un-grey every value); fix indented names; paginate top 50 + "Show More (N players)"; dynamic sticky-name-col width = widest name in dataset; add R. Pos. column option; fix preset-button page-jump; column separator lines (all breakpoints); remove row striping (all breakpoints); mobile name truncation + smaller font; drag-reorder live highlight + background shuffle | table.js, metrics.js (SAMPLE_FLOORS), table CSS | Sonnet/high | F2, G2 | pending |
| T2 | Search rework: header search & table search as SEPARATE features (header always dropdowns, clears on pick, Enter no-op; table search = add-to-results pin); relevance ranking (exact/prefix then whole-DB career appearances) both bars; pins pill AFTER filter pills + colour tint + bound to table | omnisearch.js (+ new header-search module), main.js (wiring), db.js (search query), table.js (pins), search CSS | Sonnet/high | T1 | pending |
| R | Fresh-eyes integrated review of whole diff | read-only | Opus/xhigh | all | pending |

## Waves (≤2 concurrent; each wave's agents own disjoint files + disjoint CSS regions)
- W0: E (explorer)
- W1: F1a ‖ P
- W2: F1b ‖ G1
- W3: F2 ‖ G2
- W4: T1
- W5: T2
- W6: R (review) → orchestrator fixes → re-verify

## Muting-removal coordination
G2 (W3) removes benchmark.js's SAMPLE_FLOORS/sampleFloorFor use BEFORE T1 (W4) removes
the table/metrics muting + export. Different files, correctly ordered.

## Deferred to NEXT design phase (noted, no work now)
- Player-popup graphing done properly (point 17 feature).
- Mobile chart truncation / reduced mobile chart functionality (24).
- Global font/space minimisation to maximise table area (25).
- Point 23 "mobile scope one-line-expand" is MOOT (scope strip removed on all viewports).

## Communication fixes (no code — orchestrator behavior/memory)
- 26: stop vague time references ("July review"); when a fix has nothing visible to
  check, say so plainly instead of listing it as a review item.
- 28: only mention anchor re-verification when a change actually touched calc code, and
  explain it's a regression guard (DB never changed).

## Pinned agents to create in .claude/agents/ (Phase 4)
orch-explorer (haiku/med, read-only) · orch-implementer (sonnet/high) ·
orch-heavy (opus/xhigh) · orch-reviewer (opus/xhigh, read-only).

## STATUS: Batch 1 COMPLETE + GATE 1 APPROVED (with revisions → Batch 1B).
Now planning Batch 1B (filter/header revision) + Batch 2 (graphs/popup) to run in
PARALLEL, interleaved at ≤2 concurrent. Awaiting owner approval of this combined plan.

## Batch 1B — filter & header revision (owner notes 1–9, 11–13 of the Gate-1 reply)
Two popup sections: **Search Conditions** (Gender·Discipline·Format·Date·Team type)
+ **Advanced Filters** (everything else, as grouped condition types). Player section
folded in. Grouped "+ Add condition" taxonomy:
- Player: Role · Batting hand · Bowling style · R. Pos.
- Team: Played for (single picker, no current/historic — date scopes it) · Against(opposition)
- Match: Event · Venue
- Basic metrics · Advanced metrics (dot%/boundary% STAY; dismissal-% REMOVED from filters
  — those are table columns only)
Date: NO default; day/month/year granularity; presets (last month / last 12 months /
year-to-date / last calendar year); **REQUIRED** — Search blocked with no date (no
all-time; data isn't all-time). Team+Event+Venue option lists gender-scoped; relevance
search (team: text→games; event: text→games→recency; assume clean names — dirty base
names are a separate data cleanup). Header shrunk to one row, subtitle REMOVED. Toolbar
to ONE row. "Group rows" removed. Parked: note 10 (per-event date ranges), note 14
(format-specific table options + final column sets).

Batch-1B tasks (serial within 1B — shared files):
| # | Task | Owner files | Model/Effort |
|---|------|-------------|--------------|
| 1B-1 | QUERY LAYER (number-producing → R2 verify): event+venue filtering via join to matches (gender-scoped); searchTeams/searchEvents/venue option loaders w/ relevance; day-level date clause; state keys event/venue, drop team mode | filters.js(buildScopeClauses), state.js, playerData.js/new searchOptions | data-engineer / sonnet + R2 verify |
| 1B-2 | POPUP RESTRUCTURE: 2 sections, fold Player into Advanced, grouped condition taxonomy, Team/Event/Venue conditions, date picker+presets+required, remove dismissal-% from filters, gender-contextual lists | filters.js, drawer.js, drawerInnings.js, advanced.js, pills.js, popup CSS | frontend / **opus** high |
| 1B-3 | HEADER+TOOLBAR: header→one row + remove subtitle; toolbar→one row; remove Group rows | index.html, table.js(toolbar), main.js(subtitle), header/toolbar CSS | frontend / sonnet |

## Interleaved waves (≤2 concurrent, disjoint files: 1B=filters/header, 2=graph/player)
- Wave A: **1B-1** (data-eng/sonnet) ‖ **G1** (fe/opus: Line+Slope fix, Dumbbell rebuild)
- Wave B: **1B-2** (fe/opus) ‖ **P** (fe/sonnet: popup Pace/Spin group + Graph-this-player inert)
- Wave C: **1B-3** (fe/sonnet) ‖ **G2** (fe/opus: graph no-defaults/recommend-after-metric/metric-persist/back-link)
- Then: orchestrator verify → GATE 1B + GATE 2 (presented together, reviewed separately).
Batch 3 (table internals: muting removal, top-50+ShowMore, R.Pos column, dynamic name
width, preset-jump, drag polish, separators/no-striping, header-vs-table search split +
player relevance + pins) still comes AFTER, its own gate.

## HANDOFF STATUS (2026-07-14, session break — resume here)
DONE + COMMITTED on polish-b1-mechanical (main untouched, owner gates every wave):
- 28123cb F1a+F1b, 7d42989 F2 (Batch 1: Filters popup foundation, GATE 1 APPROVED)
- d9a8970 Wave A (1B-1 event/venue/day-date query layer + G1 Line/Slope/Dumbbell)
- 62302f1 Wave B (1B-2 popup rebuild + P popup pace/spin + inert graph button)
- 2f847ee R3 Wave 1 (filter-popup 9 fixes incl. AND/OR restore + graph repairs:
  binder error, 15-cap removed, search fixed, slope labels out of plot)
R3 Wave 2 DONE + VERIFIED IN BROWSER (2026-07-14): ad1b569 [7b] pill fix (root
cause: non-pin pill removal went through onFiltersChanged with requery:false —
state updated but table never re-queried; now ALL pill removals requery; query
builders untouched) + 3399456 [8] zebra (only ONE striping rule existed, shared
.data-table/.mini-table; .mini-table dropped; Pace/Spin group-row highlight was
already correct). Verified live: baseline 2,813 → +Event ICC Men's T20 World Cup
= 360 → pill × → instant 2,813; SA Yadav popup anchors exact (60/1,544/29.13/
150.34, vs Spin 38/322/454/140.99, 913 of 1,027 balls); popup mini-tables flat,
PACE/SPIN subheadings highlighted, main-table striping intact; console clean.
R3 Wave 3 DONE + VERIFIED IN BROWSER (2026-07-15): d791ef6/890c9b4/563e7c9 —
graph-local store (deep clone of Stats state; re-seeds ONLY when a new Stats
search changes the applied scope, bare tab toggles keep graph edits); "Graph
filters" popup reusing mountFilters/mountFilterDrawer bound to the graph store
(filters.js/drawer.js/state.js/main.js/index.html UNTOUCHED — popup appended by
graph.js); day-level Window A/B date inputs seeded from scope's exact days;
no-defaults (chart type → "Choose a metric to draw…", no Recommended until a
metric chosen, metric persists across types, honest "X can't be shown on a
donut chart" refusal); "← Back to your table" restored. Verified live: 2,813
baseline; popup seeded Men/Batting/T20/Intl 2023-07-01→2026-07-02; Slope
windows 1Jul23–30Dec24 / 31Dec24–2Jul26; discipline→Bowling applied to graph
only (Slope re-rendered "top 12 by wickets"); back-link → batting table intact
(2,813, Karanbir Singh 2,454); toggle back → graph still Bowling; console
clean. Known notes: graph.js now ~2600 lines (split deferred); second
.filters-popup in DOM (hidden when closed); back-link clicks the Stats view
toggle programmatically. AWAITING OWNER GATE for Wave 4. Remaining waves (one
at a time, ≤2 agents, checkpoint-commit + browser-verify per wave, STOP for
owner go between):
- R3 Wave 3 (solo, opus, big): [12] Graphs get their OWN Filters popup — graph-local
  scope state seeded (copied) from the Stats state on entry, opened from a Filters
  button in the graph controls; reuse mountFilters/mountFilterDrawer factories
  bound to a graph-local store; do NOT edit main.js/index.html (append popup shell
  from the graph module) so Wave 4 stays disjoint. Includes [10] day-level dates in
  graph windows + inherit the Stats set's exact dates (fixes the Window A/B month-
  select display desync noted in 2f847ee), plus the old G2 items: NO auto-render/
  default metric on chart-type click, 'Recommended' tag only AFTER a metric is
  chosen, metric persists across chart types (invalid metric for a type -> honest
  message, no silent swap, no graph), restore '← Back to your table' link.
- R3 Wave 4 DONE + VERIFIED (2026-07-15): 0244e18 (agent: subtitle node +
  updateScopeSentence + Group rows select/wiring removed; grouping internals
  dormant in state.js/table.js, describeScope now dead — future cleanup) +
  orchestrator CSS fit fix (agent's width arithmetic was ~60px over: search
  max-width 16rem→10rem, .select--compact 11rem→8.5rem, presets gap
  space-2→space-1). Verified live at 1280: header one row (empty + loaded),
  toolbar one row (Filters|search|count|presets|Vs|Graph/Columns/Clear-red),
  2,813 baseline (data rolled to 15 Jul; day-bounded anchors immune),
  375px wraps gracefully, Graphs back-link → intact table, console clean.
Then: full verification pass + fresh-eyes review, present GATE for round 3. Parked
by owner: format-specific table presets + column sets; per-event date windows;
mobile charts; player-popup graphing; global font/space shrink (all 'later
discussion' items). Batch 3 (table internals: muting removal, top-50+Show More,
R.Pos column, dynamic sticky width, preset-jump, drag polish, column separators,
search split/relevance/pins) was superseded in part by rounds 2-3 verdicts — the
NOT-yet-built table items remain: muting removal, top-50 pagination + 'Show More
(N players)', R.Pos column option, dynamic name-col width, preset-button page-jump
fix, drag live-shuffle, column separator lines, no-striping (Wave 2 covers), search
relevance ordering + header-search clear-on-pick + pinned-pill colour/placement.
R3 Wave 5 DONE + VERIFIED (2026-07-15, cb7b7d0): muting fully removed (metrics/
table/benchmark; benchmarkFloorNotes stubbed; benchmark best-other can now be a
thin-sample outlier — FLAGGED to owner for review round; benchmarkChart.js dead
branch + .paper-card__benchmark-anchor-value--thin orphaned, cleanup later);
top-50 + Show More (N); R.Pos column (mode, tie→lowest, CORE-scope CTE only —
by design, matches filter; verified SA Yadav=4 + row anchors exact); dynamic
sticky width (offscreen probe, 96-224px clamp, ≤640px fixed 6rem); indented
names root-cause = button UA text-align:center; preset-jump fixed (overlay over
visible table instead of hidden); separators .data-table-only; drag live DOM
shuffle. Verified live: 2,813 + top-row values byte-identical, Show More
(2,763), scrollY stable on preset click, drag 6s→before-Runs stuck, console
clean. R.Pos condition in drawer dropdown is honestly-inapplicable (excluded
via conditionApplicability) — cleaner drawer-side exclusion deferred.
R3 Wave 6 DONE + VERIFIED (2026-07-15, 074cec2): relevance ranking lives in
playerData.js searchPlayers (NOT db.js — brief's file map was stale; pills in
pills.js not table.js): tier CASE (exact/prefix/substring over player_matches
name history) + whole-DB appearances CTE tiebreak; header clear-on-pick in
main.js onOpenPlayer (synthetic input event resets omnisearch state); pin pills
render last + .pill--pinned accent tint. Verified live: "kohli"→V Kohli first →
popup opens + header input cleared; pin SA Yadav under Runs≥5000 → pills
[Runs ≥ 5000][+ SA Yadav(tinted)] + row 60/1,544/29.13/150.34 EXACT; unpin →
instant requery to 0 players; console clean. Pre-existing quirk flagged: esc()
doesn't escape LIKE wildcards (%/_) in search terms.
ALL R3 BUILD WAVES COMPLETE. FRESH-EYES REVIEW DONE (2026-07-15, opus
read-only over 2f847ee..HEAD): NO CRITICAL/HIGH defects. Verified clean:
R.Pos LEFT JOIN provably can't perturb aggregates (unique-key CTE, rn=1);
R.Pos column/filter share byte-identical tie-break; __sample removal complete
(zero live refs); search ranking reorders only, esc() blocks injection; no
id collisions between the two .filters-popup shells (all container-scoped);
measure probe inert (all table queries container-scoped); loadToken guards
mid-flight pill removal; back-link selector resolves. Orchestrator verified
900-1150px toolbar wrap live (1024px = graceful 2-row wrap, no overflow).
OPEN ITEMS for owner at gate: benchmark best-other can be thin-sample outlier
(sanctioned but confirm); graph card footer can show stale "vs Spin" token
from cloned matchup state (cosmetic); graph popup lacks focus trap (a11y
parity question). CLEANUP TICKET (defer): benchmarkChart.js:76-79 dead
anchorMuted branch + .paper-card__benchmark-anchor-value--thin orphaned CSS;
main.js:230 splitAllowed/SPLIT_DIMENSIONS dead import + splitBy plumbing +
describeScope "grouped by" token (describeScope itself LIVE via graph.js:1952
footer); search appearances CTE = full player_matches aggregate per keystroke
(could restrict to hit ids); esc() LIKE-wildcard quirk (%/_); R.Pos condition
exclusion belongs in drawer dropdown; file splits (graph.js ~2600,
table.js ~2136). ROUND 4 (owner verdicts 2026-07-15, 11 items; plan approved w/ ODM =
"Domestic Limited Overs"): W1a 22186f6 (preset dropdown + Since 2020 —
upper bound = data max date, owner may want wall-clock today; condition
order G/D/F/TT/Date; format renames First Class/Domestic Limited Overs in
filters.js FORMAT_DISPLAY_LABELS, display-only; "Regular position" label
override in drawer.js ADD_CONDITION_LABEL_OVERRIDES) + W1b 2f26a20
(standalone graph: graphScopeApplied flag joins hasStatsResults gate, root
cause = seedSelection() hard-gated on Stats results; empty-state text names
graph Filters; visible date-validation msg; metric-aware recommend() rule
table replaces static pool≥10→Scatter; radar = checkbox dropdown max 10
min 3, radarGroups.js DELETED, radar-valid = higherIsBetter!==null — newly
exposes direction-having totals as axes, flag to owner; per-type metric
lists already filtered elsewhere, radar was the outlier) + 4d38b52
orchestrator fix (.filters-popup .filter-bar align-items flex-end→
flex-start; taller date column stranded selects below dead space; base
.filter-bar too). ALL W1 VERIFIED LIVE 2026-07-15: fresh-load standalone
flow (no-dates Apply → red "Choose a start and end date"; Since 2020 →
2020-01-01→2026-07-13 data-max; Apply → pool 15 of 3,563); Runs→Bar rec,
Average→Scatter rec; Donut list totals-only + honest refusal intact; radar
3 of 17 metrics → 6 small multiples (SA Yadav/Rizwan/Babar/Buttler…);
format list Test/ODI/T20/First Class/Domestic Limited Overs; "Regular
position" in add-condition; console clean. REMAINING R4: W2 = item 9
header-search popup fixed scope (since 2020-01-01, T20 default, ALL team
types — playerPopup/playerData/main.js, anchor-verify vs manual equivalent
search) solo; W3 = item 11 cleanup batch (stale graph footer matchupVs
token, benchmarkChart dead branch + orphaned CSS, splitBy plumbing +
dead splitAllowed import, appearances-CTE perf restrict-to-hit-ids, esc()
%/_ note, R.Pos condition exclusion from drawer dropdown) solo. Item 10 =
no floors anywhere CONFIRMED (already built state). R4 W2 DONE + VERIFIED (2026-07-15, 0ab5483): header-search popups use fixed
scope (2020-01-01→data max, T20 default, BOTH team types, player's own
gender via fetchPlayerGender — NOTE gender was already inert in popup
queries, player_id filters it); fork = {fixedScope:true} opt from main.js
onOpenPlayer → playerPage effectiveState() (fixedScopeState || store.get());
table-click + in-popup Find-another-player unchanged (in-popup search
reverts to TABLE scope — flagged, one-line change if owner wants fixed
scope to persist); scope line honest per path ("fixed default view, not
the table's filters — narrow with Filters below" vs old suffix);
playerFilters toMonthValue() fixes latent day-date→month-select gap.
VERIFIED LIVE: SA Yadav header popup = 205/6,345/36.05/159.90/HS 117 +
"Opposition splits are international-only for now" note; EQUIVALENCE EXACT
vs manual search T20/Since-2020/both-team-types (6,126 players, his row
identical digit-for-digit); table-click popup keeps old suffix + table
scope; console clean. playerSections.js now 638 lines (over cap, noted).
R4 W3 (cleanup) DONE + VERIFIED (2026-07-15, e2652e9 + partials): (1) graph
footer stale matchup token fixed via cloneStatsScopeForGraph() stripping
matchupVs (state.js describeScope untouched); graph seed now always plain
query path (correct "graph ignores matchup"); (2) dead benchmark anchorMuted
branch + orphaned .benchmark-anchor-value--thin CSS removed (benchmarkFloorNotes
still live, kept); (3) dead splitBy/Group-rows plumbing removed across
state.js/main.js/table.js + CSS (all provably unreachable — nothing set
splitBy after R3 UI removal); (4) search appearances CTE limited to hit ids
(ranking identical); (5) LIKE-wildcard escaping (%/_ now literal, ESCAPE '\');
(6) numeric R.Pos (m:r_pos kind:position) excluded from +Add condition
dropdown via eligibleMetrics filter in drawer.js — c:rpos Player FILTER kept;
(7) in-popup Find-another-player threads fixedScope. VERIFIED LIVE: baseline
2,813 holds; graph footer no vs-token (Bar/Runs "Runs — top 15"); benchmark
renders (#2 Waseem Muhammad 80.6%, off-scale outliers present = no-floors
consequence); "kohli"→V Kohli first; "ko%li"→literal no-match; R.Pos absent
from condition metrics, "Regular position" present as Player filter; in-popup
Kohli from SA Yadav popup kept fixed scope (149/5,304/43.83/137.37 full T20
since 2020); console clean. Agent also committed previously-untracked
review/FIX_ROUND_SCREENSHOTS/ (harmless). ROUND 4 COMPLETE (item 10 no-floors
= confirmed already-built; items 1-9,11 built+verified across W1/W2/W3).
STATUS: ROUND 4 COMPLETE — AWAITING OWNER REVIEW on localhost:8000. Deferred
(not this round): literal-today vs data-max for Since-2020; radar rates-only
question; file splits (graph.js/table.js/metrics.js/playerSections.js over
cap). Merge to main stays owner-gated.
TOOLING NOTES: preview_start by launch.json name intermittently fails ('no
launch.json' despite valid file) — fallback: Bash `python3 -m http.server 8000`
run_in_background + preview_start {url:'http://localhost:8000'}. Browser caches ES
modules: fetch(file,{cache:'reload'}) each changed file then location.reload().
Data rolled to 14 Jul 2026: anchors are STABLE only with the day-bounded range
2023-07-01 → 2026-07-02 (2,813 batting / 2,049 bowling / SA Yadav 60/1,544/29.13/
150.34; Event 'ICC Men's T20 World Cup' = 360; vs Australia = 214; IPL = 0 intl /
1,243 club). DuckDB-WASM SUMs are BigInt -> Number() first. Org session limit kills
agents mid-run: checkpoint-commit before big agents, check git status after any
failure, relaunch fresh (resume via message also works).

## ROUND 3 (post-Wave-B owner review, 2026-07-12) — 15 fixes, 4 waves, one at a time
Decisions: graphs get their OWN Filters popup (point 12, build now — supersedes old G2
brief); AND/OR restored (14); Role→Bowler exposes FINE bowling styles (2); dismissal
COUNTS stay, moved to a new "Dismissal type" group (3+15); option lists scoped by
team type too (7a — IPL must not appear under International); name condition under
Player writing state.search (6); "[team] N games" labels (4); selected-first on
reopen (5); compact one-row Search Conditions w/ gender+discipline as plain dropdowns
(1). Bugs: pill-removal leaves table stuck at 0 (7b); graph binder error "ORDER BY
matches" + empty header-entry pool + dead player search (9); slope labels inside plot
(11); pool force-capped to 15 (13). Zebra striping only in main table (8). Wave 3 =
graph-filters architecture (12+10+no-defaults+Recommended-after-metric+back-link).
Wave 4 = 1B-3 header/toolbar one-row.
- W1: filter-popup fixes (opus) ‖ graph repairs (opus) — DISJOINT (filter files vs graph/*)
- W2: 7b persistence (opus) ‖ 8 zebra cleanup (stylist sonnet)
- W3: 12 graph own-filters (opus, solo; graph/* + graph-local popup, NO main.js/index.html
  edits — popup shell appended by graph module itself to keep 1B-3 disjoint)
- W4: 1B-3 (sonnet, solo)

## Number-producing verification for 1B-1 (independent R2 derivations)
Event filter: pick a known event, COUNT independently vs app. Venue filter likewise.
Team relevance: "India" ranks the full national team #1 (most games) not India A/Air India.
Day-date bound: a mid-month from/to returns the right slice. Baselines still 2,813/2,049
when only gender/format/teamtype/date set. DuckDB BigInt → Number() before compare.

## Owner review gates (batched — approval required between batches)
- Gate 1 = Batch 1 (F1a → F1b ‖ F2): Filters popup + page structure.
- Gate 2 = Batch 2 (G1 ‖ P, then G2): Graphs + player popup.
- Gate 3 = Batch 3 (T1 → T2): Table.
- Final: fresh Opus reviewer on whole diff → orchestrator fixes → owner MERGE gate.
Execution stays within a batch until the owner approves it; some parallelism WITHIN a
batch only (disjoint files).

## Agent invocation note
Using EXISTING project agents (Explore / frontend-engineer / data-engineer /
design-stylist) with an explicit `model` per spawn, NOT new .claude/agents/ pins —
the harness already has these loaded this session and they're role-matched; per-agent
effort isn't a spawn param, so thoroughness is encoded in each prompt. (Future runs:
pin orch-* per the template.) Number-producing edits (R.Pos-as-a-COLUMN value; search
ORDER BY; muting removal's query-shape change) get anchor re-verification by the
orchestrator against raw R2.

## Decisions log
- 2026-07-12: scope strip removed; everything → Filters popup (owner Q1=A). Section top
  renamed "Conditions" (Q2). Dumbbell rebuilt as time-window batting+bowling (Q4).
  No cross-gender persistence (owner: gender in popup ⇒ each Search fresh).
- 2026-07-12: NO auto-defaults anywhere — table AND graphs stay blank until the user
  searches/selects (owner: this is the root cause of the graph-defaults problems).
  Clear = wipe table + filters + pins. First load = blank + a prompt whose button opens
  the Filters popup. Owner wants BATCHED approval gates (3, above).
- 2026-07-12 (post-inventory refinements):
  * Batch 1 fully SERIAL (F1a→F1b→F2): scope strip + drawer share base CSS classes
    (.select/.dropdown/.segmented at styles.css:340-624), so parallel CSS edits would
    clobber. F1b‖F2 dropped.
  * F1a (Opus/xhigh) = new state/interaction model + popup shell + RELOCATE all controls
    into it (functional, ugly) + kill scope strip + Search-only trigger + clearAll() +
    empty-prompt-opens-popup. Owns: index.html, state.js, main.js, filters.js, drawer.js,
    popup-shell CSS, surgical table.js renderPrompt button.
    F1b (Opus/high) = CLEAN the section contents: compact Player profile
    (player_profile.png), Team-popover overflow fix (team_dropdown.png — escape the
    overflow:auto ancestor, like the columns popover on document.body), opposition→a
    condition row (kill standalone dropdown + "Advanced" section header, section now
    "Advanced Filters"), Men-left/Women-right, women msg "No bowling type data for Women
    available yet." Owns: filters.js, drawer.js, drawerInnings.js, advanced.js, pills.js,
    popup-content CSS.
  * G2 bumped Sonnet→**Opus/high**: metric-persist-across-types + recommend-after-metric
    + no-defaults is a subtle graph-state redesign that has needed orchestrator fixes
    before; the owner is explicitly frustrated with graphs — get it right first pass.
  * Slope REGRESSED since P1 (was 152.01/148.25 on SA Yadav, now "0 players"): inclusion
    needs a row in BOTH windows (charts.js:695) — G1 must root-cause the regression, not
    just the chart. Line: byyear min-cap 1 + single-year players render as lone dots
    (timeseriesChart.js:44-51) — G1 makes it draw sensible lines per owner intent.
  * Dumbbell rebuild is cheaper than feared: keep dumbbellChart.js's dot-bar-dot renderer;
    only repoint data from fetchDumbbellSide(Pace/Spin) to slope's fetchWindowMetric(Win
    A/B) + reuse slope's window pickers. Works both disciplines via buildQuery.

## ROUND 5 (owner verdicts 2026-07-15, 15 items → refined). Wave 1 DONE + VERIFIED.
Format restructure to 3 buckets (Red Ball=Test+MDM, 50 Over=ODI+ODM, T20=T20+IT20;
verified those 6 match_types are the complete set). Team type STAYS in Search
Conditions (reverses point-15 move). Point 15 diagnosis: ODM+International=14 is
CORRECT DATA (associate-nation internationals — ICC World Cricket League, CWC
Challenge League, WC Qualifiers), NOT a bug — the 3-bucket model resolves the naming.
- W1a 5d4a98e + companion 8f604cb (orchestrator fixed isRedBallOnly in playerSections
  to key on "Red Ball"): format 5→3, date end-default=max-date/start-blank-required,
  preset-label persists, +Add-condition restructure (Player: Name/Team/Opposition/
  Batting hand/Role; Match: Event/Venue; Basic w/ Regular position after Innings;
  Dismissal type drops "Out " prefix), narrower one-row Search Conditions + narrower
  condition rows, helper prose removed.
- W1b ffedba8: graph empty-state RULES TABLE (no default graph); filter-driven
  auto-select (metric condition keys → select metric(s) + recommend chart: ≥3 radar-
  valid→radar, 2→scatter, 1 additive+single-team→donut, else→bar, 0→rules table);
  radar metric persistence across type switch; radar percentile over FULL filtered
  pool (fetchBenchmarkPool); donut single-team-only w/ rich guidance; richer invalid
  messages (what chart is for + what metric needed); no floors (timeseries per-year
  greyer is decision-43, untouched).
VERIFIED LIVE 2026-07-15: baseline 2,813 EXACT (Karanbir Singh 2,454/54.53/175.29) —
format restructure numerically clean; 3 format buckets w/ T20 default; end-date
prefilled 13/07/2026 + start blank; preset "Year to date" label persists + fills
2026-01-01→2026-07-13; Advanced dropdown groups+order exact incl. Regular position
after Innings + dismissal labels sans "Out"; graph empty rules table (all 9 charts);
Runs≥300 filter → auto Runs+Bar "Runs — top 15" (pool 434); radar 3 axes survive
Bar↔Radar switch; radar footer "percentile rank against the 434 players"; donut
multi-team → single-team guidance; console clean.
OPEN QUESTIONS for owner: (a) Bowling style dropped as a standalone +Add-condition
entry (owner's Player list omitted it; still reachable via Role→Bowler) — re-add?
(b) auto-select also fires from an inherited Stats scope that already has metric
conditions (consistent w/ filter-driven rule; manual chart click disables it) — OK?
REMAINING R5: Wave 2 = player-popup shrink + scope-line "Data for [format] ([team
type]) from [start] to [end]" (point 3). Point 12 no-floors = confirmed.

## R5 Wave 2 DONE + VERIFIED (2026-07-15) + Bowling style re-add.
- 1aee520: Bowling style re-added to Player +Add-condition group (owner: he'd only
  been thinking of batting filters). Order now Name/Team/Opposition/Batting hand/
  Bowling style/Role — verified in dropdown.
- 3ed9208: player-popup header shrunk (toolbar row ~69px→~47px, controls 40→30px min-
  height, name gets margin above) + scope line reworded to "Data for [format] ([team
  type]) from [start] to [end]" (scopeLine() in playerSections.js, FORMAT_BUCKETS
  labels, both entry paths; old "leaderboard-only…"/"fixed default view…" suffixes
  dropped). playerPage.js untouched (CSS + scopeLine only).
VERIFIED LIVE: header-search popup = "Data for T20 (International + Domestic) from
1 Jan 2020 to 13 Jul 2026" + visibly tighter toolbar + name breathing room; table-
click popup = "Data for T20 (International) from 1 Jul 2023 to 13 Jul 2026" (reflects
table scope); console clean.
CLEANUP-DEBT noted by agent (defer): scopeLine fixedDefault param now unused;
overlayTokens() now unused-but-exported; header controls 30px min-height below the
40-44px tap-target guidance (owner asked for compact — eyeball mobile).
ROUND 5 COMPLETE — all 15 items across W1+W2 built + browser-verified. Baseline
2,813 exact throughout. AWAITING OWNER REVIEW on localhost:8000. Merge to main
still owner-gated. Deferred to a later "player graphs" effort: single-player
composition donuts (dismissal types, 1s/2s/…/6s). Open non-blocking: header tap-
target size on mobile.

## ROUND 6 (owner 2026-07-15, 4 issues) — DONE + VERIFIED.
NOTE: the first popup agent (spacing+scroll) died with a CLEAN tree (no commit) —
orchestrator did that fix inline instead. Owner correction mid-round: do NOT
unilaterally carve out scope; take requests literally & ask before building if
genuinely unsure (see [[feedback-no-unilateral-scoping]]).
- f116a48 (orchestrator): player popup — more space above name (.player-page__header
  margin-top space-2→space-5, ~3rem clear air) + header row non-sticky
  (.player-page__header-row position sticky→static; scrolls away with body, × stays).
- 41b88b7 + 51d925a: graph fixes. #2/#3 benchmark FIELD + radar percentile pool =
  the CANDIDATE set (fetchBenchmarkPool restrictIds = selection.getFull() ids), not a
  whole-scope query — fixes "random players" (Anthony Hillman/M Stoman) appearing when
  only a few players were searched. #4 auto-select DEFAULT = biggest names by whole-DB
  career games (fetchCareerGames). CORRECTION 51d925a: Best/Worst RESTORED to metric
  ranking (recovered from ffedba8); ONLY the default auto-select uses biggest-names —
  new 4th mode "Top names" (default) alongside Best|Worst|Manual.
VERIFIED LIVE 2026-07-15: default entry "Runs — 15 most-capped players" = Buttler/de
Kock/Maxwell/Miller/Warner/Kohli/Sharma/Williamson…; Best → "Runs — top 15" (top
scorers); Worst → "Runs — bottom 15"; 3 searched players (Kohli/Rohit/Dhoni) →
Benchmark "V Kohli vs the field" compares ONLY vs Dhoni/Rohit (no random names);
radar footer "against the N players in the current selection"; popup name has clear
space; toolbar scrolls away on scroll, × stays; baseline 2,813 exact; console clean.
STATUS: R6 COMPLETE — AWAITING OWNER REVIEW on localhost:8000. Merge to main still
owner-gated.

## ROUND 7 Wave 1 DONE + VERIFIED (2026-07-15). Wave A=690fb83 (table), Wave B=5930772 (filters/footer).
VERIFIED LIVE: #7 rank column (follows sort, continues past Show More); #8 center-align
+ content-width cols (name left); #9 no zebra + dense ~16 rows/screen; #12 frozen bold
centered darker header (Wave A capped .table-scroll max-height 65vh → body scrolls
internally; header th sticky top:0); #13 Player column sortable (▲/▼, rank renumbers);
#1 date From·To·Preset one row + narrower Gender/Discipline/date boxes; #3 footer "Data
as of 13 Jul 2026" = manifest max_match_date (not today); #4 advanced-condition edit +
close-via-× no longer changes table/pill/badge (root cause was pills/badge rendering
live from store, not a re-query — fixed via appliedState snapshot); #6 "Reg. Batting
Position" label; #14 Clear resets preset dropdown to "Preset…". Baseline 2,813 exact;
console clean.
OPEN QUESTION #5 (opposition ordering): the loader IS games-desc, but by IN-SCOPE
games — in a men's-T20I window associate nations (Indonesia 105, Bahrain 84) genuinely
outrank India (73)/Pakistan (71) because they play more qualifier matches. Owner's
wording "most games in THE DATASET" + their consistent "total dataset not filtered"
preference suggests they want WHOLE-DATASET games ranking (big nations top). ASK owner
before changing.
FLAG for owner manual check (automation can't cleanly drive pointer-drag): #10 column
drag drop-index (root cause fixed: null overKey→append replaced w/ midpoint scan) and
#11 mobile double-click name-expand.
DESIGN CALLS to confirm: table body now scrolls internally (65vh cap) so the header can
freeze; header is darker bg + bold dark text (departs from old muted editorial header).
REMAINING R7 Wave 2: graph rework (#15 shared-filter Graph button, #16 bidirectional
shared filter store, #17 metric-before-chart + no premature 15-cap, #18 REMOVE
Recommended entirely, #19 graph Clear button, #21 expose Best/Worst) ‖ #20 opposition
popup "show everything" (remove intl gate + cap). Awaiting owner go + #5 answer.

## ROUND 7 Wave 2 DONE + VERIFIED (2026-07-15).
Commits: 59970e2 (graph shared-filters rework), ab57bbc (opposition popup show-all),
df4a0ac (in-popup opposition-narrowing un-gated), 5fe0d7a (opposition picker =
searchTeams total-games, orchestrator fix), 99a1842 (orchestrator fix: Search
Conditions controls re-sync on popup open — shared-store display bug), 690fb83/
5930772 (Wave 1 table + filters).
VERIFIED LIVE: #16 SHARED bidirectional filters — set graph→Bowling, Stats table
returned BOWLING (2,049 baseline, Wkts/Econ/BBI cols) AND after the 99a1842 fix the
Stats popup discipline select now shows "Bowling" too (was stale). #15 Graph button
carries filters (pool 2810 of 2813, not empty). #18 no "Recommended" anywhere (grep
clean). #17 Metric selector visible BEFORE chart type; roster NOT cut to 15 pre-chart
(2810 of 2813); metric persists across types. #19 "Clear filters" button in graph
topbar. #21 Top names|Best|Worst|Manual visible in Players controls. #20 opposition
"show everything": Kohli batting vs-opposition = 24 opponents incl. IPL franchises
(Gujarat Titans/CSK/Mumbai Indians/KKR…) + international, no cap/gate; bowling vs-opp
shows Hong Kong (was gated). #5 opposition picker = searchTeams (India/England/
Australia by total games). Console clean.
MINOR CONSEQUENCE flagged: header player-popup now opens on whatever discipline the
shared store holds (opened on Bowling after a bowling graph), not always Batting —
popup has Batting|Bowling toggle so recoverable; owner to weigh.
STATUS: ROUND 7 COMPLETE (all of #1-#21) — AWAITING OWNER REVIEW on localhost:8000.
Merge to main still owner-gated.
