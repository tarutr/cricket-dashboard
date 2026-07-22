# Design phase plan — dashboard UX changes (7 owner items)

> **Rules live elsewhere:** contract = `CLAUDE.md` (repo root, auto-loaded); orchestration
> (models/effort/briefs/gates/resume) = `.orchestrator/ORCHESTRATION.md`; decisions =
> `review/owner_decisions.md` (the ONLY decision log — this file tracks wave status and
> references decisions, it does not re-narrate them).

Branch: `polish-b1-mechanical` (main untouched). NOT the cleanup — these are
intentional behaviour/UI changes. Cricket numbers stay correct (anchors: batting
2,813 / SA Yadav 60/1,544/29.13/150.34 must hold; donut/slope/dumbbell must draw the
same values once inputs are given). Orchestrated per /opus-orchestrator.

## The 7 items → grounded scope (from the code map)

1. **Stats table height** — `styles.css:1074` `.table-scroll { max-height: 65vh }`. Lower it so header+toolbar+pills+table+footer fit one viewport; table scrolls internally. CSS-only. Keep `overflow:auto` (horizontal scroll of wide columns must survive).
2. **Header + graph left panel** — (a) `.app-header` (`styles.css:144-182`, `index.html:68-108`): shrink padding (`--space-5/6`) + title (2.25rem) to a slim strip. (b) `.graph-builder__controls` (`styles.css:2039-2054`): add `max-height`+`overflow-y:auto` so it scrolls internally like the table. Do BOTH (owner: "or both"). CSS (+ maybe index.html).
3. **Graph Players controls** — remove the "Show" label (`graph.js:395`); fix the 4-button roster toggle clipping (`styles.css:2210` — add `min-width:0` + smaller font/wrap, mirror the chart-type tiles at 2107-2117); rename "Top names"→"Top Names" (`graph.js:397` button + `graph.js:1598` `rosterModeLabel`). graph.js markup + styles.css.
4. **Slope/dumbbell windows** — (a) REMOVE auto-fill: skip the 3 `ensureSlope/DumbbellWindowDefaults()` calls (`graph.js:1284, 1365, 2761`). Windows stay `null`; the existing `windowsReady` gate (`graph.js:2619, 2762`) already shows "Pick both date windows to draw this chart." → free empty-state. (b) Fix date-box text clipping (`styles.css:2149`) — stack the two date inputs, shrink icon/font, enlarge boxes. graph.js (tiny) + styles.css.
5. **Donut team filter** — NEW donut-only control. Add `let donutTeamId = null` (per-type var, isolation pattern lines 505-546); render a team `<select>` in the donut branch of `renderMetricControls` (`graph.js:1115-1133`) whose options are teams present in the **already-filtered player set**; in `renderChart`'s donut branch (`graph.js:2981-2998`) replace the `state.teams.length !== 1` message-gate with `donutTeamId` validation + filter the roster to that team before drawing. Must NOT touch shared `state.teams`. graph.js (+ CSS for the select). NUMBER-ADJACENT (changes which players the donut shows) → verify donut values.
6. **"Needs input" red outline** — when a required control is empty (slope/dumbbell windows, donut team), red-outline that control. Logic in graph.js (toggle a class on the empty control when `renderChart` hits its guard), class in styles.css.
7. **"Update chart" button** — gate the in-panel controls so tweaks DON'T auto-draw. Add a button at the bottom of `.graph-builder__controls`; make the 18 `scheduleRender()` triggers (map in exploration) + `onScopeChanged` tail set a "dirty" flag instead of drawing; only the button calls `renderChart()`. Keep control-UI updates live (`syncChartTypeButtons`/`renderMetricControls`/`renderPlayerList`). Precedent: the graph's own "Apply to graph" filter gate (`graph.js:2100-2133`). graph.js (cross-cutting) + tiny CSS. HIGHEST RISK.

## Wave structure (sequential gates; parallel within a wave on DISJOINT files)

graph.js is touched by items 3,4,5,6,7 → it can only be edited by ONE agent at a time,
so graph.js work is serialized across waves. styles.css likewise one owner per wave.

**Wave 1 — Layout & cosmetics (low risk, high visible value).** Items 1, 2, 3, 4b.
- 1A design-stylist **Sonnet/high** — styles.css + index.html: table height (1), slim header (2a), graph panel internal scroll (2b), roster-toggle clipping (3-css), date-box sizing (4b). WHY: pure established-pattern CSS/markup, the stylist's core role; Sonnet/high is sufficient and cost-right.
- 1B frontend-engineer **Sonnet/medium** — graph.js ONLY: remove "Show" label, rename "Top names"→"Top Names" (both sites). WHY: trivial mechanical markup/string edits; low tier, tight spec. Disjoint file from 1A → runs in parallel.

**Wave 2 — Graph behaviour (medium/high risk).** Items 4a, 5, 6.
- 2A frontend-engineer **Opus/high** — graph.js: remove window auto-fill (4a), donut team filter (5, novel), red-outline toggling logic (6). WHY: donut filter is novel number-adjacent logic (new control + scoped options + roster filtering); Opus warranted; one owner for graph.js.
- 2B design-stylist **Sonnet/high** — styles.css: red-outline class (6), donut team-select styling (5). Disjoint from graph.js; class-name contract agreed up front with 2A.

**Wave 3 — Update chart button (highest risk, cross-cutting).** Item 7 alone.
- 3A frontend-engineer **Opus/xhigh** — graph.js: gate all 18 render triggers + onScopeChanged behind a dirty-flag; add "Update chart" button + wiring; disable export while dirty. WHY: architecture-touching render-model change; xhigh care. Must land AFTER Wave 2 so it gates the new slope/dumbbell/donut triggers too.
- Button CSS: small — folded into 3A's brief (match existing `.btn` styles) or an orchestrator touch.

**Phase 5 — Integrated review.** Opus/xhigh fresh reviewer over the whole diff +
orchestrator browser pass: anchors (2,813 / SA Yadav) hold; every chart type draws;
donut/slope/dumbbell values correct once inputs given; Update-chart gating captures
all triggers; console clean; one-viewport fit at desktop + mobile.

## Verification per wave
`node --check` touched .js; boot localhost:8000 zero console errors; on-screen anchor
2,813; exercise every chart type; screenshot desktop + 375px. Wave 2 also: donut value
spot-check vs a manual DuckDB team total. Wave 3 also: confirm no auto-draw on any
control change; Update chart draws; dirty indicator behaves.

## OWNER ANSWERS (resolved 2026-07-16)
- Q1 header: **compact ~50px strip** (one row: wordmark + search + toggle).
- Q2 font shrink: **graph controls only** — Stats table text UNCHANGED.
- Q3 Update-chart: **in-panel controls only** — KEEP the graph's 'Apply to graph'
  filter button; the new button gates chart type / metric / players / windows.
- Q4 red-outline: **the empty required control** (date-window inputs, donut team select).

## STATUS: Wave 1 DONE + verified + committed (658c5ad). Wave 2 spawned.
Class contract for item 6: graph.js adds class `needs-input` to the empty required
control (date-window inputs / donut team select); styles.css styles `.needs-input`
with a red border/outline. Donut team select wrapper class: `graph-donut-team`.
Known W1 gap (owner deferred): ~375px mobile residual outer scroll.

## Wave 2 DONE + verified (awaiting commit + owner decision on donut set).
4a: slope/dumbbell windows start blank (auto-fill removed; dead helpers deleted). 6:
`needs-input` red outline on empty windows (4/4) + empty donut team select, clears on
fill. 5: donut team picker (106 in-scope teams, blank-first); values EXACT (India
249/127/51 vs DuckDB); isolation OK (Stats 2,813, Bar full-scope, no team leak). OPEN
DECISION: donut currently shows shared-roster ∩ team (India w/ default top-15 roster =
only 3 players). Likely owner wants team's-own-players (proper composition). Flagged.

## Wave 2 COMPLETE + committed (8cc7c7b + dc66e20 donut refinement). Owner chose
team's-own-players: donut India = 40 players, DuckDB-exact (total 12,535). Verified.

## Wave 3 spawned (item 7, solo Opus/xhigh, owns graph.js + button CSS in styles.css).
Owner: Update-chart gates IN-PANEL controls only; KEEP graph's 'Apply to graph' filter
button drawing. Button sticky at bottom of .graph-builder__controls (panel scrolls).
Owner will audit all 3 waves together after W3.

## Wave 3 COMPLETE + committed (1a09567). Fresh-eyes Opus review of ee84930..HEAD:
NO blocker/should-fix. 3 NITs: (1) donut tile still greys via roster min-cap (stale
reason for new donut model); (2) donut team-prune can re-light Update btn just after
Apply/Clear when a picked team falls out of scope (honest, edge-case); (3) comment
casing "Top names" drift (cosmetic). Gating verified: scheduleRender reachable only via
renderAndClearDirty (1 site); 6 live-draw paths clear the gate; no stuck/over-gated
path. DESIGN PHASE BUILD COMPLETE — awaiting owner audit of all 3 waves on localhost.
Deferred: ~375px mobile one-screen fit (owner); export-while-dirty (left working).

## ===== DESIGN ROUND 2 (owner 2026-07-16, 11 items) =====
Owner answers: layout wireframe APPROVED w/ constraint = entire LEFT COLUMN (To Stats/
Filters/Clear top row -> toolbar card -> Update chart -> Export/Copy PNG) must fit
within the HEIGHT of the chart card (Graphs tab = one screen, no scroll). #7 search
unification = EVERYTHING incl. short metric dropdowns (build 1 reusable searchable
dropdown, single+multi variants, apply to ALL selects/searches). #9 calendar = LEAVE
NATIVE (browser limitation, accept quirk — no work). #10 added out-of-filter players
scoped under the SEARCH CONDITIONS (gender/format/date/team-type), exempt from narrowing
filters (team/opp/advanced/position).
Waves: R2-1 layout restructure (#1,2,3,4,5,8,11) frontend/Opus-high; R2-2 search
unification + donut team fix #6 (frontend/Opus-high, big); R2-3 add out-of-filter #10
(frontend/Opus-xhigh, fetch-scoping).
Key file refs (from exploration): .graph-builder grid styles.css:2068 (300px+1fr ->
wider toolbar); .graph-builder__controls internal-scroll styles.css:2085-2095 (REMOVE);
topbar graph.js:352-358 (move OUT top; "Back to your table" graph.js:353 -> "To Stats");
chart-type grid graph.js:361-363 + handler 2078-2106 + syncChartTypeButtons 2028-2053
(-> dropdown; native select interim in R2-1, custom component in R2-2); export-row in
.graph-builder__stage graph.js:425-429 (move to left col below toolbar); update-bar
graph.js:415-417 (move OUT bottom); app-main top pad styles.css:270 --space-5 (reduce);
slope date row .graph-slope-range (stack->row); donut team fetch graph.js:1066-1088 (use
buildQuery for HAVING-correct set); add-player players.js:165-198 (unscope) +
fetchSelectedPlayerMetrics charts.js:37-81 (relaxed-scope fetch for added ids).
## R2-1 spawned.

## R2-2b (search unification, everything else). Owner: go ahead. Name box decision:
convert Advanced-Filters "Name" from a substring filter (state.search ILIKE) to a
PICK-FROM-A-LIST searchable player picker (multi-select to match sibling condition
pickers; flag single-vs-multi to owner). NUMBER-ADJACENT (query changes name-ILIKE ->
player IN picked). Watch the state.search sharing with the table search box.
Sub-waves: R2-2b-i (frontend/Opus-high) = extend searchSelect.js with a MULTI-SELECT
variant + apply to graph radar metrics, benchmark metrics, benchmark player-anchor
(single). R2-2b-ii (frontend/Opus-high) = filter drawers Team/Opp/Event/Venue + Name
conversion (drawer.js/drawerInnings.js/advanced.js) — verify filter result counts.
R2-2b-iii (frontend/Sonnet-high) = player-popup selects Against/Vs/Date (playerFilters.js).
Serialize i->ii->iii (styles.css shared; ii depends on i's multi variant). Docs pass
deferred to END of design phase (owner agreed): owner_decisions.md log + CHART_SYSTEM.md
+ README/SPEC donut/layout staleness (Sonnet/high doc pass).
## R2-2b-i spawned.

## ===== DESIGN ROUND 3 (owner 2026-07-16) — Stats toolbar redesign =====
DECISION: The Advanced-Filters "Name" condition is REMOVED (redundant with the
results-toolbar player search). RULE (owner, emphatic): EVERYTHING WAITS FOR SEARCH —
no exceptions. Every toolbar/table control (dates, Vs, preset dropdown, Columns, player
search, AND column-header SORT) is pending; the table is a frozen snapshot. The ONLY
things that update the table: the Search button (applies pending + queries) and Clear
(resets to empty first-load state). No carve-outs (I wrongly proposed a sort exception;
corrected).
- R3.1 (drawer cleanup, frontend/Sonnet): remove Name condition from drawer.js/
  drawerInnings.js (mountNamePlayers etc.); make "Reg. Batting Position" (c:rpos)
  BATTING-ONLY (absent for bowling). Orchestrator already reverted the namePlayers
  query wiring in filters.js/state.js/table.js/graph.js/pills.js.
- R3.2 (Stats toolbar redesign, frontend/Opus-XHIGH; owns table.js/main.js/styles.css/
  index.html + a drawer.js touch): SINGLE-ROW toolbar [Filters · Search(small) ·
  From–To · Core-preset ▾ · [Vs│value]] left / [count · SEARCH · Columns · Clear] right.
  Toolbar ALWAYS visible on first load (no "Open filters" prompt); table body empty
  until Search. EVERYTHING pending until the toolbar SEARCH button (replaces the toolbar
  Graph button) — uses the app's appliedState snapshot; red date-outline (graph's
  needs-input) if a player is picked but no date. Dates in toolbar SYNCED with the popup
  (both bind state.dateFrom/To). Vs ADDED to the popup as an "+ Add condition" type
  right AFTER Innings, synced with the toolbar bonded control (both edit state.matchupVs).
  Preset pills -> plain dropdown (label just "Core", 4-ish options, greyed on first
  load). count/Columns/Vs/preset/Search all greyed on first load; only Filters + player
  search + dates active. Clear -> first-load state. TOP-STRIP Graph toggle GAINS the
  seed (enterFromBridge preferredMetric + matchup->Dumbbell) so removing the toolbar
  Graph button loses nothing (top strip LAYOUT still untouched). #6 SPACING: tighten
  page-header->table gap AND table->footer gap; grow the table card much longer.
  Keep baseline 2,813 + every filter count exact; matchup buildMatchupQuery untouched.
## R3.1 spawned (drawer); orchestrator did the 5-file namePlayers revert.

## ===== DESIGN ROUND 4 (owner 2026-07-17) — APPROVED 6-wave plan =====
Fresh session; handoff = review/DESIGN_ROUND4_HANDOFF_SPEC.md. Orchestrator = Opus 4.8.
TWO HARD RULES: numbers sacred (only WHEN/HOW things display change, never WHAT a query
returns); take owner instructions literally, never invent exceptions.
Owner clarifications resolved before approval (2026-07-17):
- The Vs ("matchup") dropdown must be an INTERNAL SEARCH over the fully-filtered player
  set: every filter that chooses WHO is in the table must carry into Vs mode. Code audit
  found only TWO filters currently drop: R. Pos. (state.regularPositions, gated
  !matchupVsActive) and PINS (buildMatchupQuery has no pin OR-injection). Everything else
  already carries (team/opp/event/venue/profile/core scope/search).
- R. Pos. carries with its PLAIN meaning (usual/modal batting position; owner chose "usual
  top-order players, full record vs bucket"). The ball-level batter-faced-position filter
  (state.positions; "+ Add condition -> Batting position"; Vs-ONLY; powers the anchor
  Bumrah vs RHB pos 1-2 = 27/177/9) is untouched.
- Numeric stat conditions RE-SCORE against the bucket ("SR>=140" -> "SR vs pace>=140"):
  owner confirmed correct/desired — NO change.
- +4 new Vs stats (app-side ONLY, no pipeline/DB change): Matches, Runs per Innings
  (one-liners), High Score, Best Bowling (two-step: subtotal per innings vs bucket, then
  max/min). Verified live: SA Yadav HS vs Spin = 47 (method reproduced anchor 38/454).
- X-ball SR (first10 / 11-20 / 21+) ruled CONCEPTUALLY MEANINGLESS vs a style — permanently OUT.
- Pin pills recolour red -> steel-blue; A9 = all four option lists scoped to full conditions.
Anchors re-proven EVERY wave: 2,813 / Karanbir 2,454 top / SA Yadav 60·1544·29.13·150.34 /
Bumrah vs RHB pos1-2 27·177·9 / SA Yadav vs Spin 38·454·SR140.99 (coverage 913 of 1,027).
Waves (each gated; I verify in-browser + independent DuckDB for number-adjacent; commit; STOP):
- 4a frontend/Opus-high — instant-vs-waits (un-do R3.2 over-gating: sort/columns-picker/
  drag-reorder/player-search INSTANT & stop lighting Search; preset/filters/dates/Vs
  PENDING) + pills reflect PENDING + pin recolour steel-blue + pill soft-delete-with-undo.
  Owns table.js/main.js/pills.js/styles.css; query builders forbidden.
- 4b data-engineer/Opus-XHIGH — Vs adheres to filters: carry R.Pos(modal)+pins into
  buildMatchupQuery; R.Pos pill/badge live in Vs; pins not greyed. Owns table.js(matchup)/
  filters.js/state.js/pills.js/drawer.js/drawerInnings.js. NUMBER-ADJACENT.
- 4c data-engineer/Opus-high — +4 Vs stats (metrics.js + table.js matchup query). NUMBER-ADJACENT.
- 4d frontend/Sonnet-high — Keep-Selected-Columns toggle + no-data pin "(no innings)"+toast
  (both modes) + graph rename "Reset to full filtered set" (inline). Owns table.js/main.js/
  pills.js/drawer.js.
- 4e data-engineer/Opus-high — A9 option lists scoped to full conditions. Owns playerData.js/
  drawerInnings.js. NUMBER-ADJACENT.
- 4f (3 parallel, disjoint files) frontend/Sonnet-high playerFilters.js popup selects +
  docs/Sonnet-high (owner_decisions/CHART_SYSTEM/README/SPEC) + hygiene/Sonnet-medium (dead CSS).
## 4a spawned.
## 4a COMPLETE + committed (42c24d9) + orchestrator-verified.
Diff scope: only table.js/main.js/pills.js/styles.css (+docs); filters.js/metrics.js/state.js/
graph EMPTY diff; buildQuery/buildMatchupQuery byte-identical (only comment+call-site touched).
node --check all pass; 0 console errors. On-screen anchors EXACT: 2,813 / Karanbir 2,454 /
SA Yadav 60·1544·29.13·150.34 (BF=1,027 matches coverage anchor). Behaviour verified in-browser:
instant sort (no is-dirty), instant columns-picker add (no is-dirty), pending Vs (is-dirty lights
+ table frozen), dirty is COMPARISON-based (revert Vs->Everyone clears it), Clear resets to
first-load + clears staged. Pills: pending pill appears instantly (table frozen), pin steel-blue
(#e8eef5 bg / #2f4761 text), soft-delete pill--staged (red outline #9c2b2b, ×->+, restore works).
RESOLVED FORK (owner 2026-07-17): PICKING a player from the results search DROPS THE ROW INTO
THE TABLE IMMEDIATELY (no Search press, does NOT light is-dirty). Scope is ADD ONLY — a pin
pill's ×/+ stays PENDING (soft-delete stages with red-outline undo, commits on next Search),
exactly as approved 4a; filter pills stay PENDING. (Orchestrator over-reached first by making
×/+ instant too; owner corrected; reverted in commit b556f92 — pick-instant, ×/+ pending.) Built as addendum + orchestrator-verified
in-browser: pick SA Yadav -> is-dirty stays false, row appears with EXACT 60·1544·29.13·150.34,
count/other rows unchanged; agent also showed the out-of-filter additive case (Team=Australia 37
rows, pin SA Yadav -> rank 1, × -> 36). Pin × -> pill--staged (red outline #9c2b2b, ×->+), is-dirty
stays false. Query builders BYTE-IDENTICAL (buildQuery/buildMatchupQuery untouched); calc files
empty diff; node --check pass; 0 console errors.
## 4a (incl. instant-pin addendum) COMPLETE + orchestrator-verified. Awaiting owner gate -> 4b.

## 4b (Vs dropdown honors full filter set: fix R.Pos+pins carry, harden via shared pin
helper + parity guard) BUILT + orchestrator-verified. Awaiting owner gate. See plan
~/.claude/plans/this-is-way-too-glowing-origami.md; decision 47(a). Independent verification:
byte-identical normal query (djb2 3307620867/1430) AND clean matchup query (1547662675/1790);
anchors re-derived via hand-written DuckDB under the real T20+IT20 scope — baseline 2,813
(2,810 ids + 3 dual-name), SA Yadav vs Spin 38/454/140.99, Bumrah vs RHB pos1,2 27/177/9;
buildQuery SQL confirms R.Pos+pins now present in batting-Vs, R.Pos batting-only, pins in
both disciplines; CSK scenario on real data 35->12 (10 top-order R.Pos + Kohli/Bumrah pins),
Kohli pin = full vs-pace 45/1340/170.05 (bypasses Team=CSK), non-pins are CSK; parity guard
green; node --check all; 0 console errors. FLAG for owner: R.Pos is now batting-only — it was
previously ALSO active in plain bowling (odd bowler_id IN batting clause); now inactive there,
aligning with the R3.1 "Reg. Batting Position BATTING-ONLY" ruling (no anchor affected).
Deferred: "(no innings)" pin annotation (Wave 4d); the 4 new Vs stats (Wave 4c).

## COVERAGE-BREAKDOWN wave BUILT + orchestrator-verified. Awaiting owner gate. Replaced the
single matchup "Coverage — N of M (X%)" column with per-group composition columns.
Table (Vs mode): batting Pace/Spin/Uncategorised BF %, bowling RHB/LHB/Uncategorised % —
ordinary sortable/draggable/toggleable columns, far-right + default on, sum to 100% per row,
table-only, computed un-filtered by the Vs bucket (extends the coverage machinery). Popup:
coarse "Vs pace and spin" + "Vs L/R-handers" tables gain a right-most "% BF"/"% balls" column;
coverage text line retained; fine "Vs bowling type" table unchanged. Files: metrics.js (6 new
composition metrics), table.js, state.js, advanced.js, playerData.js, playerSections.js,
styles.css (filters.js UNTOUCHED). Independent verification: plain query byte-identical
(3307620867/1430); existing matchup stats byte-identical (SA Yadav vs Spin 38/454/140.99,
Bumrah vs RHB pos1,2 27/177/9); composition SA Yadav 57.5/31.4/11.1, Bumrah 65.6/26.2/8.2,
sum to 100% across all 2,401 batting + 2,028 bowling rows (the 1 non-100 row = Sajid Patel,
0 legal balls -> honest NULL "—"); ON SCREEN: 3 columns render far-right, Coverage gone,
Spin BF % sort works instantly (no Search re-trigger), popup "% BF" column present in coarse
table + text line kept + fine table unchanged; node --check all; 0 console errors. Owner-
approved behaviour override: this reverses decision 36's "Coverage always fixed" (now
toggleable). Bowling popup "% balls" column agent-verified (Bumrah RHB 62.2/LHB 29.2); I
independently verified the batting popup.

## 4-item polish batch (checkbox restyle, format-keeps-team, popup renames) COMPLETE +
verified + owner-approved ("looks good"). Also: all "Style data"/"Batting-hand data" popup
coverage lines renamed to "Matchup data" (owner-approved; last one committed 59e82e5).

## 4c (four new Vs stats: Matches, Runs/Innings, High Score, Best Bowling) BUILT +
orchestrator-verified. Awaiting owner gate. New matchup metrics, OPT-IN columns in the Vs
picker (DEFAULT_MATCHUP_COLUMNS + filters.js untouched -> default Vs view + plain anchors
byte-identical). HS/Best Bowling via a two-step peak CTE (per match:innings, then max/arg_max).
Independent DuckDB (exact): SA Yadav HS vs Spin=47, RPI 11.95, Matches 38; Bumrah Best Bowling
vs RHB="2-9", Matches 32; SA Yadav vs Spin 38/454/140.99 + Bumrah vs RHB pos1,2 27/177/9 hold;
plain fingerprint 3307620867; composition %s still 100. 0 console errors. Table-only
(vsTableOnly flag) — NOT in popup/graph. OPEN for owner: (a) Best Bowling renders "2-9" (dash,
mirroring plain "Best Bowling") — owner said "W/R"; confirm dash vs slash. (b) Matches +
Runs/Innings ALSO auto-exposed as Vs stat-conditions (consistent with the re-score model);
HS/Best Bowling are columns-only; keep or restrict. (c) popup/graph parity deferred.
Remaining R4 queue: 4d (keep-columns + no-data pin + graph rename), 4e (A9 option-list scope),
4f (popup selects + docs + hygiene).

## ===== DESIGN ROUND 4 — HANDOFF #2 CONTINUATION (fresh session 2026-07-18) =====
Authoritative brief = review/DESIGN_ROUND4_HANDOFF_2.md (supersedes the 4d/4e/4f queue
line above for THIS session's scope). Owner instruction THIS session: build Wave A (4
filter/condition fixes) → STOP for owner go → Wave B (matchup-aware Graph). Player-popup
filters explicitly DEFERRED (not this scope). Orchestrator = Opus 4.8.
Baseline re-proven on localhost:8000 (2,813 / Karanbir 2,454 / SA Yadav 60·1544·29.13·150.34).
Open reconciliation to raise at gate: whether owner still wants the old 4d/4e/4f queue
(handoff #2 reorganized the remaining work into Wave A + Wave B and did not list them).

### Wave A — filter & condition fixes (shared drawer.js → land in BOTH Stats + Graph)
Code map (Explore, 2026-07-18) → items 2+3 share guard lines (advanced.js isMetricRemoved-
FromFilters 167-176; table.js conditionToHaving matchup-peak guard 552-563 + conditionApplic-
ability 600-623) → ONE owner. Nearly all items overlap drawer.js/table.js/metrics.js/pills.js
→ minimal safe parallelism → two SERIAL stages, split by tier:
- **A1 (frontend-engineer / Sonnet-high)** — item 1 (rename "Vs"→"Matchup (Vs)" in
  SINGLETON_TYPES + move to TOP of "+ Add condition" list) + item 4 (drop "(Innings)" from
  Best Bowling label for single-innings formats T20/50-Over, keep for Red Ball/Test).
  DISPLAY-ONLY. Owns drawer.js, metrics.js (label strings ONLY — no sqlExpression/sortExpr/
  kind changes), pills.js, table.js (toolbar literal line 1245 ONLY — must NOT touch
  conditionToHaving/buildQuery/buildMatchupQuery). Anchors byte-identical by construction.
  Flag (do NOT build): toolbar hardcoded "Vs" (table.js:1245) does NOT auto-rename — surface
  to owner at gate, don't extend scope.
- **A2 (data-engineer / Opus, xhigh-thoroughness)** — item 2 (Best Bowling TWO-box condition
  "≥ W wickets for ≤ R runs", rank ≥ W*1000−R, plain AND Vs; new condition input type) +
  item 3 (High Score as a Vs condition, single box, MAX per-innings runs vs bucket). Both need
  the same peak-wiring machinery (unblock matchup-peak guard for best/high_score; wire peak.*
  into buildMatchupQuery final WHERE — which today is built BEFORE the peak CTE exists).
  NUMBER-ADJACENT → orchestrator does independent hand-written DuckDB verification.
  Runs AFTER A1 commits + orchestrator-verifies. Owns table.js (conditionToHaving/
  buildMatchupQuery/conditionApplicability), advanced.js, metrics.js (best/high_score),
  drawer.js (conditionRowHTML two-box), pills.js (two-value pill).
Note: item 3 is Stats-table-only in practice this wave (Graph nulls matchupVs until Wave B).
## A1 spawning.
## A1 COMPLETE + orchestrator-verified (commits 978e30a/88b0069 + 2bc377b state.js completion).
Items 1+4 display-only; anchors byte-identical (2,813 reproduced on screen); "Matchup (Vs)"
first in "+ Add condition" in BOTH Stats+Graph; Best Bowling label format-aware (T20->no
"(Innings)", Red Ball/mixed->"(Innings)") incl. the describeScope scope sentence (live in Graph).
## A2 COMPLETE + orchestrator-verified (commits f9895dd/b54091e). Items 2+3 number-adjacent.
Independent DuckDB targets all matched EXACTLY on screen: item3 HS>=47 vs Spin=83 (SA Yadav in)/
>=48=73 (out); item2 Vs >=2W<=9R vs RHB=800 (Bumrah in)/<=8R=781 (out); item2 plain >=5W<=20R=72.
No aggregation string changed; filters.js untouched; plain fingerprint 3307620867/1430 held;
2,813 baseline reproduced after A2. Two-box UI + single-box HS + pills all correct.
## WAVE A COMPLETE + orchestrator-verified. Owner gate PASSED (2026-07-18):
(a) toolbar "Vs" STAYS "Vs" (owner: do not rename); (b) re-score-in-Vs behaviour confirmed correct;
(c) owner ruled ALL of 4d/4e/4f must be done + player-popup dropdown change APPROVED.

## ===== WAVE C (owner-approved 2026-07-18: 4d + 4e + 4f) — build plan approved =====
Order: Wave C (now) → Wave B (matchup Graph) → docs (4f-C) LAST (after Wave B, avoid rework).
Source descriptions: review/DESIGN_ROUND4_HANDOFF_SPEC.md (A5/A6/A8/A9/B/C/D). Provenance:
A9=decision 47e (already approved); popup-dropdown conversion=owner 2026-07-18. A7 (R.Pos Vs-drop)
already resolved in completed Wave 4b — NOT in scope here.
### C1 — three PARALLEL workers, disjoint files:
- **C1a = 4d** (frontend-engineer/Sonnet-high) — (A5) "Keep Selected Columns" checkbox in Filters
  footer left-of-Search, default OFF (OFF→new Search resets cols to scope default via
  defaultColumnsFor; ON→persist cols+order); (A6) no-data pin "(no innings)" pill note + toast
  (reuse src/toast.js showToast — main.js already flags this as "a later wave"); (A8) graph.js:400
  rename "Reset to filtered set"→"Reset to full filtered set". DISPLAY-ONLY. Owns main.js, state.js,
  drawer.js, pills.js, table.js, graph.js, styles.css (imports toast.js). Anchors byte-identical.
- **C1b = 4e/A9** (data-engineer/Opus) — Team/Opposition/Event/Venue option lists scope to FULL
  conditions (gender+format+date+team-type), was gender+team-type only. playerData.js searchTeams/
  searchEvents/searchVenues gain optional format+date scoping; drawerInnings.js callers pass
  state.formats+dateFrom/dateTo. NUMBER-ADJACENT → orchestrator independent DuckDB. Only caller of
  those loaders is drawerInnings.js (backward-compat safe). Owns playerData.js, drawerInnings.js.
- **C1c = 4f popup dropdowns** (frontend-engineer/Sonnet-high) — convert playerFilters.js native
  selects pf-dateFrom/pf-dateTo/pf-opposition/pf-vs to the shared searchSelect component (single-pick,
  searchable). CONTROL-STYLE ONLY — no new filters, no popup re-scope, no player-graph sorting (still
  deferred). Owns playerFilters.js (searchSelect.js only if a variant is missing → flag).
### C2 (serial, after C1a commits): 4f-D hygiene = dead-CSS removal from styles.css (Sonnet/medium,
grep-proven unused). ### Docs (4f-C) deferred to after Wave B.
Agents do NOT drive the browser (avoid 3-way contention); orchestrator does authoritative in-browser
+ independent-DuckDB verification. Anchors: 2,813 / Karanbir 2,454 / SA Yadav 60·1544·29.13·150.34.
## C1 spawning (3 parallel).
## WAVE C COMPLETE + orchestrator-verified (2026-07-18). Commits: 5d95e4e/40ad503 (4d), 040229b (4e),
cd351ba (4f popup), d590583 (4f-D hygiene) + progress notes. NOTE: parallel workers share one working
dir; C1a's broad `git add` tangled commit ATTRIBUTION (4f files landed in a 4d commit) — CODE is intact
(disjoint file ownership held; final working tree verified per-file). Cosmetic history only, not a defect.
Verification (all on localhost:8000, 0 console errors):
- 4d-A5 Keep-Columns checkbox present (footer, left of Search, default OFF). 4d-A6 "(no innings)" pill
  verified live (pinned NR Sciver-Brunt → "+ NR Sciver-Brunt (no innings)", count stays 2,813). 4d-A8
  graph button reads "Reset to full filtered set".
- 4e/A9: app loaders == INDEPENDENT DuckDB EXACTLY — full(male/T20/intl/2023-07-01→2026-07-02)=105 teams/
  228 events/179 venues; narrow(2026-06-01→07-02)=41/15/13 (strict subset); no-format/date fallback=110
  (backward-compat). filters.js UNTOUCHED, buildQuery byte-identical → main anchors unaffected.
- 4f popup: pf-dateFrom/pf-dateTo/pf-opposition/pf-vs all now <div class="search-select"> (searchable,
  35 opposition options, opens with search input). searchSelect.js gained a portal for mountSearchSelect
  (needed — popup panel is overflow:auto; flagged, legit). Clear-button visual-reset bug also fixed.
- 4f-D hygiene: 11 dead class rules removed (each grep-proven 0-ref), in-use classes kept
  (fpop-keep-columns/pill--no-innings/search-select/table-toolbar__clear-btn), only styles.css touched
  (-155 lines), braces 580/580, no visual regression.
- ANCHOR after Wave C: 2,813 / Karanbir 2,454 / SA Yadav 60·1544·29.13·150.34 reproduced on screen.
STOPPED for owner gate. (a) docs (4f-C) deferred to AFTER Wave B.
## 4e FOLLOW-UP — owner ruled (2026-07-18) EXTEND the clearing logic, no special-case (see
[[feedback-build-foundations]]). BUILT + orchestrator-verified (commit after 92c18b1). filters.js:
format change + dateFrom + dateTo + applyPreset now clear teams/event/venue/opposition (mirroring the
existing gender/team-type handlers); profile kept (as team-type does). buildScopeClauses BYTE-IDENTICAL
(only the 4 UI change-handlers touched); node --check pass. In-browser: committed Team=India CLEARS on
both a format change (untick Red Ball) and a date change (pill gone, picker→"All teams"); baseline
2,813 held (clear is a no-op on empty picks). NEW expected behaviour to note at review: a format/date
change now drops any Team/Opp/Event/Venue pick, same as a gender/team-type change. (Earlier confusion
"India still showing" was a test-timing race with the multi-select's deferred commit, not a bug.)
NEXT = Wave B (matchup-aware Graph) — owner signalled proceed ("review all three when done"); I'll open
Wave B with the charts.js approach + per-chart-type plan for a quick pre-build check (handoff mandate).

## ===== WAVE B (matchup-aware Graph) — approach APPROVED + Line ruled IN (owner 2026-07-18) =====
Charting-layer map (Explore, 2026-07-18) confirmed the approach. CORE INSIGHT: the table computes all Vs
numbers via ONE builder — buildQuery auto-dispatches to buildMatchupQuery when matchupVsActive(state)
(table.js:739-744). The Graph BLOCKS Vs by nulling matchupVs in a read-through store wrapper
(graph.js:309-321). Fix = stop nulling + route the graph's fetch through the SAME builder so Vs values
are IDENTICAL to the table (no parallel number logic). Reusable machinery CONFIRMED: fetchWindowMetric
(charts.js:109) already runs buildQuery unchanged (slope/dumbbell nearly free); benchmark.js
fetchBenchmarkPool DELIBERATELY forces matchupVs:null (documented) — just un-force + repoint. HARDEST
item: charts.js fetchSelectedPlayerMetrics (37-81) hand-rolls plain-only SQL (backs bar/scatter/phases +
Best/Worst ranker) — needs a matchup branch routing through buildQuery (wrap+filter by id, the
fetchWindowMetric pattern), PLAIN path left byte-identical. ~25 metric-picker sites in graph.js use raw
state.discipline/getMetric(k,discipline)/eligibleMetrics(discipline) → repoint to effectiveNamespace(state)
(already accepts a matchup-namespace string). Owner per-chart ruling: ALL types get Vs including LINE
(new matchup-by-year query approved). buildMatchupQuery NOT exported but buildQuery IS + auto-dispatches.
Owner FYI accepted: Vs is shared Stats+Graph state (fixes the live bug); peaks — High Score charts fine,
Best Bowling (compound "W-R") greyed where a single number is needed.
### B1 (frontend-heavy / Opus, number-adjacent) — Bar/Scatter/Radar/Phases/Benchmark/Slope/Dumbbell Vs-aware.
Owns graph/graph.js (un-null wrapper 309-321 + repoint all ~25 sites), graph/charts.js
(fetchSelectedPlayerMetrics matchup branch via buildQuery + fetchWindowMetric enablement; PLAIN byte-
identical), graph/benchmark.js (un-force matchupVs:null + repoint), graph/phaseFamilies.js (matchup
families + repoint), graph/players.js (searchPlayers matchup branch iff roster/add needs it). Line/byyear:
GREY under Vs (interim, must not error) — B2 implements it. Best Bowling: grey where single-number needed.
MUST NOT touch buildQuery/buildMatchupQuery/buildScopeClauses/metrics.js aggregation. Solo → may drive
browser to self-verify; orchestrator does authoritative independent pass.
### B2 (data-engineer / Opus, number-adjacent) — Line-by-year for Vs: NEW matchup-innings-by-year query
in graph/timeseries.js + wire graph.js byyear site + un-grey Line under Vs. AFTER B1 (shares graph.js).
Independent DuckDB verification. ## B1 spawning.
## B1 COMPLETE + orchestrator-verified (commits 2076ca2..a60e9eb). Only src/graph/* touched; table.js/
filters.js/metrics.js/state.js/drawer.js/timeseries* = 0 diff; node --check pass. charts.js
fetchSelectedPlayerMetrics: matchup branch ADDED (routes through buildQuery, wrap+filter-by-id idiom),
plain branch BYTE-IDENTICAL. INDEPENDENT verification via the exported fetch: PLAIN Karanbir 2,454 /
SA Yadav 1,544 (leaderboard-identical); Vs=Spin SA Yadav 454 / Waseem 701 / Virandeep 688 (== my DuckDB).
On screen under Vs=Spin: Bar renders (JC Buttler 470 == independent DuckDB), subtitle "…vs Spin", metric
list = matchup namespace, Line shows "(unavailable)", other 7 types available, console clean.
### KEY FINDING / owner decision (vsTableOnly): the 4 Wave-4c stats (High Score, Matches, Runs/Innings,
Best Bowling) carry `vsTableOnly:true` in metrics.js ("table only, never the graph") AND handoff Part D
DEFERRED "popup/graph parity for the 4 new Vs stats." So B1 CORRECTLY excluded them from the graph
(honoring the ruling + deferral) — this CONTRADICTS my earlier "High Score charts fine" statement to the
owner (my error). Wave B charts all standard Vs metrics (runs/SR/avg/dismissals/dot%/boundary%/phase SRs
etc.); charting the 4 vsTableOnly stats would need relaxing the flag (metrics.js) = a separate owner-ruled
follow-up. SURFACED to owner as an honest correction + decision. B1's other flags (comp_* excluded =
correct; applyGraphFilters sort-key on plain = benign order-only; dirty-dot test artifact) = non-issues.
## B2 spawning (Line matchup-by-year).
## B2 COMPLETE + orchestrator-verified (commits 279ec86..03cd878). Only timeseries.js + graph.js
touched; sacred files 0 diff; node-check OK; plain Line byte-identical (timeseriesSupported refactor
parity-preserving). buildMatchupTimeseriesQuery auto-dispatches like buildQuery (matchup view + bucket
predicate + per-(id,year) + matchup-namespace sqlExpression). INDEPENDENT: SA Yadav runs vs Spin by year
141/92/63/158 = 454 (anchor) — exact. Line un-greyed + selectable under Vs; 4 vsTableOnly stats still
excluded (B3 handles).
## ===== B3 (owner ruled 2026-07-18: make the 4 vsTableOnly stats GRAPHABLE — "deferred to THIS session") =====
frontend-heavy/Opus. The 4 stats: matchup matches (total,int,hib null), high_score (peak,int,hib true),
runs_per_innings (rate,dec1,hib true), best (peak,STR,hib true). Approach: (1) graph.js graphMetrics
(~282) drop the `!m.vsTableOnly` exclusion → the 4 enter the pool; existing per-chart filters then decide
applicability (radar/benchmark need hib≠null → matches excluded there; slope/dumbbell need rate/percent →
only RPI; line needs timeseriesSupported). (2) timeseries.js timeseriesSupported: drop the vsTableOnly
exclusion B2 added → RPI(rate)+matches(total) Line-able by year; peaks stay excluded by kind (consistent
w/ plain). (3) charts.js: Best Bowling is format:"str" (row[key]="2-9" → Number()=NaN). Add a shared
peak-value accessor: numeric value = Number(row[key]) if finite ELSE Number(row[key+"__sort"]) (the rank
wickets*1000−runs); LABEL always row[key] (the "W-R"/number). Apply across bar/scatter/radar/benchmark so
str-peaks chart by rank with the figure as label. NOTE: this also fixes/【changes】 PLAIN best charting (was
NaN/broken) — a consistency fix, flag it. MUST NOT touch buildQuery/buildMatchupQuery/buildScopeClauses/
metrics.js aggregation; values come from the existing builders. Verify (independent): High Score vs Spin
SA Yadav=47; Matches=38; RPI=11.95; Best Bowling vs RHB Bumrah label "2-9" (rank 1991); plain best now
charts by rank; non-Vs numbers byte-identical. ## B3 spawning.
## B3 COMPLETE + orchestrator-verified (commits 2ce5494/10b6818) + follow-up (790185d). Only
graph/graph.js + timeseries.js + charts.js touched; sacred files 0 diff; chartValue accessor is
byte-identical for numeric metrics (only str-peak best uses __sort). INDEPENDENT: High Score vs Spin
SA Yadav=47, Matches=38, Runs/Innings=11.95, Best Bowling vs RHB Bumrah "2-9"/rank 1991; byte-id Karanbir
2454 + Waseem 701. ON SCREEN: Best Bowling bar renders under Vs=RHB sorted by rank (AU Rashid 4-3 top →
4-10 → 4-14 → 3-x → 2-x → 1-x) with "W-R" labels; metric list offers HS/Matches/RPI. Orchestrator
follow-up (790185d, per Rule 2 + owner ruling): (a) benchmarkEligibleMetrics dropped !vsTableOnly →
runs_per_innings benchmarkable (matches/high_score/best still excluded by kind/hib/str; plain list
unchanged); (b) deriveChecked Best/Worst ranking routes through exported chartValue so Best Bowling ranks
by figure not NaN. node-check + 0 console errors. 
## ===== WAVE B COMPLETE (B1+B2+B3+follow-up) + orchestrator-verified. =====
All chart types plot Vs metrics with numbers IDENTICAL to the table (reuse buildQuery→buildMatchupQuery);
Line by year via new buildMatchupTimeseriesQuery; the 4 vsTableOnly stats graphable (Best Bowling by
rank+W-R label). Plain graph byte-identical; anchors hold. Owner flags at gate: (1) graph shows "Best
Bowling (Innings)" under T20 (Stats drawer drops it — minor label inconsistency); (2) Best Bowling bar
axis is the ranking scale (readable via W-R labels). NEXT: fresh-eyes Opus review of the Wave B graph diff
(Phase 5) + present full 3-wave review checklist to owner. Round-4 review-checklist = review/
DESIGN_ROUND4_REVIEW_CHECKLIST.md (Waves A+C+B). Docs sync (4f-C) still deferred to after owner sign-off.

## ===== ROUND 5 (owner 2026-07-19, 23-item review batch + Line redesign) — HANDED OFF TO NEW SESSION =====
Round 4 reviewed by owner ("looks good") → 23-item batch. All decisions captured in
**review/DESIGN_ROUND5_HANDOFF.md** (self-contained continuation spec, written via /opus-spec-writer) and
logged as decisions 49-51 in review/owner_decisions.md. NOT yet built — the new session executes it.
Build waves R5-A (interaction/regressions) → R5-B (pin system) → R5-C (graph cleanup) → R5-D (Line
redesign: Y×X-dimension multi-line, no floors) → R5-E (per-over pipeline extension) → R5-F (club
opposition + popup drawer tidy). Standing rules now include NO DATA-POLICING (decision 49). Anchors
unchanged. Investigation verdicts (handedness correct, RPI≠avg, coverage %, club-name fragmentation,
per-discipline condition root cause, Line-was-year-only, graph-label divergence, floors-already-mostly-
removed) are in the handoff Part B — do NOT re-investigate. This session ends here; new session picks up
from the handoff.
## FRESH-EYES REVIEW of Wave B graph diff (Opus, fresh context, read-only) — NO BLOCKERS, NO CORRECTNESS
BUGS. Independently CONFIRMED: Rule 1 (table.js/filters.js/metrics.js untouched, no sqlExpression change);
plain path byte-identical (fetchSelectedPlayerMetrics plain branch unchanged; chartValue = Number(row[key])
for all finite; timeseries/phaseFamilies plain byte-identical); NO missed repoints (every graph metric
lookup uses effectiveNamespace/graphMetrics; remaining state.discipline reads all intentional); peak
handling sound (best→__sort, high_score→value; peaks never reach slope/dumbbell/byyear/benchmark/phases);
per-chart eligibility matches fetch+render; describeScope view override safe; cache keys include matchupVs;
node-check all 6. Findings = 5 NITS only: (1) Best Bowling on a SCATTER axis shows raw rank tick numbers
(same theme as the bar-axis flag; tooltip/title correct) — ties to the owner's Best-Bowling-axis decision;
(2) benchmark curated DEFAULT_KEYS has no matchup set → under Vs the backstop pads from eligible (works;
stale comment) [B1 already suggested curated matchup defaults]; (3) byyear render uses eligibleMetrics vs
siblings' graphMetrics (functionally identical); (4) sort-key coherence check on plain discipline (NOT in
Wave B diff; byte-identical to main.js; deliberate); (5) readScope now a passthrough (trivial). Reviewer's
2 "please live-check" items ALREADY confirmed by orchestrator: `year` column exists on BOTH matchup views
(schema dump + B2's per-year Line renders for batting AND bowling); on-screen 454 Vs bar/line + Best Bowling
rank-bar-with-W-R-labels + 0 console errors all verified. Nits (2)(3)(5) → fold into the deferred docs/
hygiene pass; nit (1) → part of the owner's Best-Bowling-axis flag. ROUND 4 (Waves A+C+B) COMPLETE +
orchestrator-verified + fresh-eyes-reviewed. Awaiting owner's hands-on review (checklist) + sign-off; then
docs sync (4f-C); merge to main = separate owner decision.

## ===== ROUND 5 EXECUTION (fresh session, Opus 4.8 orchestrator, 2026-07-19) =====
Baseline re-proven on localhost:8000 before building: 2,813 / Karanbir 2,454 / SA Yadav 60·1544·29.13·150.34;
independent DuckDB COUNT(DISTINCT batter_id)=2,810 (+3 dual-name = 2,813, documented). 0 console errors.
Order: R5-A → R5-B → R5-C → R5-D → R5-E → R5-F, each gated (owner go between waves).

## R5-A (interaction rules & regressions) COMPLETE + orchestrator-verified. frontend-heavy/Opus, 9 commits
(537494a #1 · 2df5ea3 housekeeping-a · 6d869bb #5+#8 · fd24d5a #10 · b320207 #15 · af835b9 #7 · 4740b27 #9 ·
1d32da3 #4 · c2bad39 progress). Display/state only. Independent verification (my own pass):
- SACRED: filters.js/advanced.js/graph/* = 0 diff; metrics.js deletion-only (minSampleComponent, 114 lines);
  buildQuery BYTE-IDENTICAL, buildMatchupQuery/conditionToHaving differ by COMMENT LINES ONLY (renamed dead
  helper ref) — SQL generation unchanged.
- ANCHORS on screen + independent DuckDB: 2,813 / Karanbir 2,454 / SA Yadav 60·1544·29.13·150.34; SA Yadav
  vs Spin 38·454·140.99 (on screen row 11 + hand-written DuckDB); Bumrah vs RHB pos1,2 27·177·9 (DuckDB).
- ITEMS: #1 no toolbar note ✅; #4 toolbar-commit PRESERVES row order (Karanbir stays top, values swap) +
  header-click RE-SORTS (Waseem 701 top) ✅; #5 "Matchup (Vs)" first in Advanced-metrics optgroup above Dot
  Ball % ✅; #7 per-discipline conditions ✅ (impl: state.advanced = current discipline, state.advancedBy-
  Discipline archives both, swapped in createStore.set via swapAdvancedForDiscipline; identity filters
  profile/teams in separate state fields → persist; escape-hatch honors explicit reset patches); #8 striker
  "Batting position" is own addable entry, no auto-added dropdown when Vs active ✅; #9 filters popup fully
  staged — table stays on APPLIED state through drawer edits + close (pills from applied) ✅; #10 Keep-Columns
  greyed on blank + discipline-mismatch ✅; #15 picker resync (worker-verified). 0 console errors.
- FLAGS for owner: (a) housekeeping-b MIN_BALLS_PER_YEAR NOT removed — its only consumer is a point-fade in
  graph/timeseriesChart.js (must-not-touch this wave; R5-D rewrites the Line and removes it). So the old
  thin-sample fade still lives in the CURRENT Line chart until R5-D; decision-49 fully satisfied at R5-D, not
  R5-A. (b) sort-arrow honesty: after an order-preserving toolbar commit the header still shows its ▼ arrow
  though rows aren't in that order — intended per #4 "values swap in place", but the arrow can mislead; owner
  may want it dimmed/cleared (NEW decision, not part of #4). (c) #7 storage-shape divergence flagged by worker
  (archive pattern vs literal state.advanced.batting/.bowling) to respect the graph.js must-not-touch boundary
  — same behaviour, byte-identical SQL, impl reviewed clean.
- Minor: one stale comment at drawer.js:498 still names the removed conditionApplicability() helper (cosmetic).
STOPPED for owner gate → R5-B. OWNER GATE PASSED: ruled the sort arrow = active-sort-only (decision 52,
folded into R5-B); "will check the rest after the waves are done"; go for R5-B.

## R5-B (pin system + sort-arrow ruling) COMPLETE + orchestrator-verified. frontend-heavy/Opus, commits
c6fb042 (#0 arrow) · 518ce86 (#3/#2/#11/#12 pins) · bb35083 (#6 auto-add). Only table.js/main.js/styles.css
touched (+ progress). Independent verification (my own pass):
- SACRED: filters.js/drawer.js/advanced.js/metrics.js/graph = 0 diff; buildQuery/buildMatchupQuery/
  conditionToHaving/advancedToHaving ALL byte-identical (extractor diff, 828a90d..HEAD).
- ANCHORS on screen: 2,813 / Karanbir 2,454 / SA Yadav 60·1544·29.13·150.34; SA Yadav vs Spin 454·140.99
  (builder unchanged → matchup anchors hold).
- #0 arrow (decision 52): fresh Search shows RUNS ▼; after an order-preserving TOOLBAR Vs Search, DOM shows
  NO header with an arrow or is-sorted class (anyArrowOrSorted=[]); a header click brings it back. ✅
- #3 pin column: pinned SA Yadav → is-pinned/aria-pressed=true, floats to top keeping TRUE rank "11" (top
  reads 11,1,2,3…); DOM confirms only ONE row pinned (the A-Sharafu "dark pin" was a hover artifact, not
  state); persists through a toolbar Vs Search; resets on popup Search (code-confirmed). ✅
- #6 (number-adjacent): autoAddFilteredColumns appends only an EXISTING metric's column + sets sort to it;
  no-op without conditions → anchor byte-identical; runs on popup Search only. Worker independent DuckDB
  (ROW_NUMBER, not app's arg_max) matched top-8 + count 680. ✅
- #2 search-floats-to-top / #11 no-data pin shows in-scope record or "–" / #12 marking — worker-verified
  (SA Yadav bowling vs LHB = 1inns/4balls/1wkt/4runs == DuckDB; P Nissanka pinned → all "–", count steady).
- OWNER-DECISION FLAGS (surfaced, not blockers): (a) a floated pin shows its TRUE leaderboard rank in # (top
  = "11" then 1,2,3) — worker's honest-rank choice vs renumbering pins; (b) pin-COLUMN toggle is instant both
  ways while the pin-PILL × stays a pending soft-delete (decision 47g) — inconsistent, owner may want unified;
  (c) #6 runs regardless of Keep-Columns + ranks by the FIRST filtered metric when several apply.
OWNER GATE (post-outage): access to live_db restored via ccd_directory grant + app restart (owner keeps
scoped-to-live_db access on purpose; won't grant Desktop-wide). Owner: keep momentum, review at the end,
run the disjoint cleanup waves. R5-C + R5-F run back-to-back (share styles.css → sequential), present together.

## R5-C (graph cleanup) — 6 of 7 built + orchestrator-verified; #18 STOPPED & flagged. frontend-heavy/Opus,
commits f9e0efb(#23) · 9a0fcd0(#22) · 70227e3(Scatter) · 5bbc553(#13) · 97346a8(#19) · 008545e(#20) · ea84e66(note).
Only src/graph/* + metrics.js + advanced.js + styles.css touched. Independent verification (my pass):
- SACRED: table.js/filters.js = 0 diff; metrics.js deletion-ONLY (0 additions; the 2 runs_per_innings blocks
  removed, no other sqlExpression/sortExpr/kind changed); buildQuery/buildMatchupQuery/conditionToHaving/
  advancedToHaving BYTE-IDENTICAL. `grep runs_per_innings|Runs per Innings src/` = empty.
- ANCHORS on screen: 2,813 / Karanbir 2,454 / SA Yadav 60·1544·29.13·150.34; SA Yadav vs Spin 454·140.99
  (builder unchanged). 0 console errors on BOTH Stats + Graphs.
- #20 RPI: gone everywhere (hasRunsPerInnings=false in doc + batting + bowling metric pickers + add-condition
  list + Columns). #22 Best Bowling: ABSENT from graph metric picker in batting AND bowling (definitive test);
  stays as BBI table column + two-box condition. #23 metricDisplayLabel routed into graph.js/charts.js — no
  "(Innings)" anywhere. #13 "Reset to full player set", greyed when roster=full, boxed with the x-of-x dropdown.
  #19 red needs-input outline now on chart-type + empty metric pickers (+ existing windows), clears on fill.
  Scatter: X excludes Y's pick and vice-versa.
- OPEN — #18 needs an OWNER DECISION (worker correctly built nothing per its guardrail): the standalone
  "Matchup mode" note was ALREADY removed by R5-A, and NO personal-data coverage note exists anywhere in Stats
  (never did; Part B's ~89%/71% were investigation figures, not rendered content). So #18 as written would
  require INVENTING a new note + a live coverage computation. Question queued for owner: create it? wording?
  which figure (in-scope % / men-overall / live-per-scope)? when shown (always / with profile filters / Vs)?
- EYEBALL — #19 fresh-load: on a pristine Graphs tab the chart-type picker shows the red outline (built per
  literal brief/acceptance); owner may want it suppressed until the first Update (1-line change).
- Non-issue: card.js chart title uses raw label but is moot (no "(Innings)" metric graphable after #22).
STOPPED → running R5-F next (back-to-back), then present C+F together.

## R5-F (club opposition #14 + popup-drawer tidy #16) COMPLETE + orchestrator-verified. frontend-engineer/
Sonnet, commits e672ec7(#14) · 424b399(#16). Only state.js/drawerInnings.js/playerFilters.js/styles.css touched.
- SACRED: filters.js + table.js = 0 diff. state.js's only behavioural change = `oppositionFilterActive` drops
  the `teamType==="international"` requirement (now true whenever an opposition is picked) — the whole #14
  query-side change, achieved WITHOUT editing buildScopeClauses.
- #14 independent DuckDB (my own): club vs Punjab Kings, COUNT(DISTINCT batter_id) with team_type='club' +
  bowling_team='Punjab Kings' + date scope = 152 — matches the app's narrowed count exactly. International
  anchor unchanged (2,810 ids + 3 dual-name = 2,813; opposition empty → gate false → SQL identical).
  Team-name normalization correctly NOT attempted (decision 51 defers it).
- #16: player-popup Filters drawer restyled to main-drawer density — Date window one row, Batting position +
  Vs paired on one row, narrower 320px panel reusing --space-*/--text tokens. Verified on screen (SA Yadav
  popup: header 60·1544·29.13·150.34, pos-4 = 34·967·32.23·150.39). 0 console errors; app boots clean.
- FLAG: for #16 the worker merged the posSection/vsSection hide-toggles into one battingRow (a small markup
  restructure, not pure CSS) so the two controls share a 2-col grid row — no query/behaviour/scope change;
  show/hide on batting↔bowling still works. Judged within "grid layout"; noted.
- Worker also caught+fixed a self-introduced module bug (backticks inside an HTML comment in a template
  literal) before reporting; app now boots clean (re-verified).
STOPPED → consolidated gate: present C+F + #18 question + #19 eyeball + R5-D Line design check.

## CONSOLIDATED GATE PASSED (2026-07-21, decision 53): owner APPROVED the R5-D Line design (two dropdowns,
all 11 X-dims together, per-bucket Y via existing sqlExpressions grouped per (player,X-bucket), no floors),
cap = 6 player lines. #18 coverage note PARKED to final review (none exists today). #19 fresh-load outline
left as-built. C+F confirmed done.

## R5-D (Line redesign) SPAWNED — data-engineer/Opus, xhigh, number-adjacent. Owns graph/timeseries.js +
timeseriesChart.js + graph.js + charts.js + styles.css. Reuses metric sqlExpressions (GROUP BY player×X-bucket
= the Rule-1 guarantee); deletes MIN_BALLS_PER_YEAR (last floor). X-dim→source mapping handed to the worker.
Heavy checkpoint order (commit each): dropdowns+engine+Date-year/month → direct-column dims → Innings index →
Match result → Phase (wide→long) → Vs bowling type (matchup source) → delete floor/old year-line. Worker exposes
an importable engine fn for console verification. Orchestrator will independently DuckDB-verify EACH of the 11
X-dims. AFTER R5-D verified + owner go → R5-E per-over pipeline (separate explicit go required).

## R5-D (Line redesign) COMPLETE + orchestrator-verified. data-engineer/Opus, commits 9bfb2b0 (engine+wiring)
· 8f6b275 (verification). Only graph/timeseries.js + timeseriesChart.js + graph.js touched (charts.js/styles.css
NOT needed — reused .graph-metric-select styling + fetchLineData path).
- SACRED: table.js/filters.js/metrics.js = 0 diff; `grep MIN_BALLS_PER_YEAR src/` = empty. Table anchors on
  screen: 2,813 / Karanbir 2,454 / SA Yadav 60·1544·29.13·150.34. 0 console errors on Stats + Graphs.
- ENGINE = fetchLineData({xDim, metricKey, playerIds, filters}) in timeseries.js; per-bucket Y = metric's own
  sqlExpression GROUPed per (player, X-bucket) (Rule-1 guarantee). 11 X-dims: innings, month, year, event,
  phase, position, vs_bowling, opposition, venue, innings_of_match, result.
- MY OWN independent DuckDB (called fetchLineData vs hand-written raw queries, SA Yadav 271f83cd) — ALL EXACT:
  year [466/376/218/484 Σ1544]; position [3:551,4:967,5:26]; vs_bowling [Pace:913,Spin:454] (correctly excludes
  (unmapped)=177 per decision 21); phase SR [PP 137.982 / Mid 150.505 / Death 192.708]; result [Won 1257 /
  Lost 228 / Tie 20 / No result 39 — 59 winner-null split by result_type]; innings_of_match [0:948, 1:596]
  (0-based innings_number, labelled Batting-first/Chasing); opposition Australia 259; innings-index [60 buckets,
  60 non-null, Σ1544]; month [Σ1544]. event+venue = direct siblings of the exact opposition (+ worker-verified Σ1544).
- ON SCREEN: Line draws through the real UI — "Runs — Line — 6 most-capped players", X=Date—year trajectory
  (Buttler 213→462→480→168 etc.), 6-line cap, players with one bucket render as a single point + honest footnote,
  NO fading/floors, two dropdowns (X axis + Metric), #19 red-outline covers the empty X/Metric.
- WORKER FLAGS (surfaced to owner): (a) Phase X offers only metrics with REAL phase definitions (batting: Strike
  Rate; bowling: Economy, Wickets) — phase-runs/balls would need NEW metric defs (Rule 1 forbids inventing);
  owner can add them to metrics.js as a separate ask. (b) categorical ordering = chronological (opp/venue/event);
  (c) tie/no-result bucketed honestly via result_type (super-over ties = Tie, not a win); (d) gaps use
  spanGaps:true (trend spans interior gaps) — owner can flip to a literal break (1-line); (e) card.js chart TITLE
  doesn't name the X-dim (out of scope; axis labels show it). (f) built as 2 commits not 7 (registry is one unit),
  but every dim verified before commit.
ROUND-5 BUILD WAVES A/B/C/D/F ALL COMPLETE + orchestrator-verified. Only R5-E (per-over) remains — needs a
PIPELINE data change → STOP for owner's explicit go before any pipeline run.

## ===== ROUND 5 CLOSE-OUT (2026-07-22) =====
- **Perf Tier 1 DONE** (commit 7b11d6e): data served via Cloudflare custom domain data.the-cordon.com +
  immutable cache headers. Verified on localhost (2,813 from new domain, CORS OK for localhost + vercel).
  Tier 2–4 + per-over documented in review/BACKLOG.md (owner parked per-over).
- **Owner review checklist**: review/DESIGN_ROUND5_REVIEW_CHECKLIST.md.
- **FRESH-EYES REVIEW (Opus, fresh context, f9abdcc..HEAD): VERDICT SHIP.** No blockers/should-fix.
  Independently reproduced: buildQuery/advancedToHaving byte-identical; buildMatchupQuery/conditionToHaving
  comment-only diffs; filters.js fully byte-identical (the #14 change is isolated to state.js oppositionFilterActive);
  metrics.js only the 2 RPI defs + minSampleComponent removed (no surviving sqlExpression changed); all 5 anchors
  exact; Line X-dims year/position/vs_bowling exact incl. rate-recombination (Spin SR 140.99); 11 X-dims present,
  per-over absent, cap 6; 0 console errors both tabs. One NIT: dead hidden pf-opp-note node in playerFilters.js.
- **NIT FIXED (owner-directed) + orchestrator re-verified**: removed the pf-opp-note <p> + its querySelector +
  the els.oppNote.hidden assignment (3 coordinated spots; deleting only the node would null-deref). node --check OK;
  player popup Filters drawer renders (opposition section present, note gone), 0 console errors. playerFilters.js only.
- **MERGE STATE**: branch polish-b1-mechanical +199 vs origin/main; origin/main +3 (numpy CI fix + 2 auto
  review-CSV commits) — branch touched neither file → CLEAN merge (dry-run: no conflicts). Deploy path: Vercel's
  GitHub integration deploys origin/main (pipeline.yml is DATA-only, no deploy step). Branch never pushed to origin.
- NEXT: push branch (backup) → fold origin/main's 3 commits → push main → Vercel deploys Round 4+5 live →
  verify cricdb.vercel.app loads 2,813. GATED on owner's final go.

## ===== ROUND 6 (owner 2026-07-22, 12-item R5-review batch) — DEPLOY HELD until bugs clean =====
Decisions 54 (batting-hand persistence removed) + 55 (graph popup fully staged) logged. Priority order (owner):
#5/#10 → #1/#3/#6 → #9 chartability UX → #7/#8/#11/#12 features.

## R6 #5/#10/#4 (graph Filters popup fully staged) COMPLETE + orchestrator-verified. frontend-heavy/Opus,
commit 2faf3c3 (graph.js ONLY; table.js/filters.js/metrics.js/main.js/drawer.js/state.js = 0 diff → Rule 1 safe).
Root cause: graph popup wired with no-op callbacks + no store-subscribe (didn't live-refresh) AND scope selects
wrote to the shared store instantly ahead of the Apply gate (→ batting metric fetched on bowling data). Fix:
graph popup gets a buffer store; edits stay in the popup + live-refresh it; "Apply to graph" commits atomically.
MY independent in-browser verification (fresh reload): #5 flip discipline in graph popup → add-condition list
live-rebuilds to bowling metrics (Wickets/Economy/Bowling SR), scoped to the graph popup; #10 flip graph-popup
discipline→bowling + close WITHOUT Apply → Stats popup discipline STILL batting + Stats table still batting
(2,813/Karanbir) = no leak (staged); anchors 2,813/Karanbir 2,454 on screen; 0 console errors. Worker also
verified #4 (avg-vs-style appears/disappears with Vs+Apply) + Apply reseeds roster 2,813→2,049 atomically +
#6 (reset now structurally correct — discipline only commits at Apply). NEXT: #1 fine-Vs re-sort + #3 BBI sort
key (+ confirm #6).

## R6 BUG BUCKET COMPLETE (2026-07-22): #5/#10 (graph staging, 2faf3c3) + #3 (BBI sort, 5a324e7) + #6
(confirmed fixed by staging) + #1 (CLOSED not-a-bug, decision 56, stale cache) + #4 (RENAMED matchup average
→ "Batting/Bowling Average", 7603626, decision 57). All orchestrator-verified; sacred SQL byte-identical; anchors hold.
## R6 #9 (chartability UX) SPAWNED — frontend-heavy/Opus. CHARTABLE/NOT-CHARTABLE badges per chart type in the
roster dropdown + don't-draw-uninformative-charts (show a plain-English "why" message instead of all-dots).
Owner approved the per-chart-type chartable rules (Line ≥2 pts; Bar/Benchmark metric value; Scatter both axes;
Radar radar metrics; Grouped Bars phase data; Slope/Dumbbell both windows). Display/UX only.
## R6 QUEUE after #9: #2 (drop batting-hand persistence, decision 54) · #7 (rename Phases→Grouped Bars) ·
#8 (broaden Line Y-axis, flag phase-metric data limit) · #11 (popup Vs-opp show-more/less) · #12 (show-top-50).
Then deploy (HELD until bugs+features clean).

## R6 #9 (chartability UX) COMPLETE + orchestrator-verified. frontend-heavy/Opus, commit 56cd14c (graph.js +
styles.css ONLY; table.js/filters.js/metrics.js/graph data-layer = 0 diff → chartability derived from existing
read-only fetches, Rule 1 safe). MY in-browser verification: Part A — roster dropdown shows red "NOT CHARTABLE"
pills per player (single-year Line scope, all 1-bucket → correctly not chartable); worker independently DuckDB-
confirmed Karanbir/Virandeep NOT CHARTABLE for stumped% (0 stumped), Kohli 1-bucket vs Buttler 4-bucket for Line.
Part B — Line + single-year (Jan–Dec 2024) shows "No selected player has enough data points to draw a line…"
message instead of a dot-field (the owner's headline case), title "0 most-capped players". Anchors hold; 0 console
errors. Worker flags: chartability computed for checked-roster ∪ ≤50 rendered rows (not full pool — perf); Benchmark
chartable rule = "has ≥1 selected benchmark metric" (ambiguous, flagged). ROUND-6 BUG BUCKET + #9 ALL COMPLETE.
## R6 REMAINING FEATURES: #2 (drop batting-hand persistence, decision 54) · #7 (rename Phases→Grouped Bars) ·
#8 (broaden Line Y-axis — needs owner decision on which phase/peak metrics; has a real data limit) · #11 (popup
Vs-opp show-more/less) · #12 (show-top-50 button). Then DEPLOY.

## R6 FEATURES COMPLETE + orchestrator-verified (2026-07-22). Commits: 7146614(#2) f490b41(#7) d15a16f(#11)
ddc79e5(#12) 253d4cf(#8). Across be0a001..HEAD: buildQuery/buildMatchupQuery/conditionToHaving BYTE-IDENTICAL;
filters.js + metrics.js 0 diff → Rule 1 safe by construction (all display/state/derive-only). MY verification:
anchors 2,813/Karanbir 2,454 on screen; #8 phase Runs via fetchLineData = [465,894,185] = my own DuckDB
SUM(pp/mid/death_runs), sums to 1,544; existing phase SR unchanged [137.982/150.505/192.708]; #2 "Batting hand"
present in batting add-condition, ABSENT in bowling (bowling keeps Team/Opp/Bowling-style/Role); #7 chart list
reads "Grouped Bars"; #12 expanded→"Show top 50" collapses to 51 rows (exactly one button per state); #11
per W2 (Ali Dawood bowling clip 133px + toggle). 0 console errors.
## R6 OPEN OWNER DECISION (from #8): plain-bowling X=Phase asymmetry — the NEW metrics (Runs-conceded/Balls/
Bowling-SR/Average) show PP+Mid+Death, but the FROZEN Economy/Wickets show PP+Death only (metrics.js never
catalogued mid_economy/mid_wickets for the PLAIN bowling namespace; matchup_bowling has all 3). Mid data exists.
Per decision 49 (show all data) Economy/Wickets should also show Mid, but that changes an existing X=Phase series
→ owner decision. Surface at the round review.
## ROUND 6 COMPLETE (all 12 items resolved). NEXT: fresh-eyes review of the R6 diff + owner's full-round review
+ the #8 asymmetry decision → then DEPLOY (Round 4+5+6 + perf, 199+ commits, to main/Vercel).
