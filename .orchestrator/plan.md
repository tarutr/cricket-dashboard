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
no floors anywhere CONFIRMED (already built state). STATUS: R4 W1 DONE —
awaiting owner gate for W2.
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
