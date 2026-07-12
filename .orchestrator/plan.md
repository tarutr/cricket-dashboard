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
| F1a | State + interaction contract + Filters-popup shell; remove scope strip from page. Store scope keys UNCHANGED; Search = the one query trigger; table persists; Clear empties; no cross-gender memory; subtitle from applied scope. | state.js, main.js, index.html (scope-strip removal + popup shell), filter/popup-shell CSS | **Opus/xhigh** | E | pending |
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
