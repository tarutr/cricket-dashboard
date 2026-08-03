# Picker/control audit — the 67 option-selecting controls (2026-08-02)

> Read-only inventory behind the harmonisation program. Input to
> `.orchestrator/harmonisation-rejig-plan.md`. Every classification verified against the
> actual markup/CSS, not names. Patterns: **N** native `<select class="select">` · **P**
> custom checkbox panel (`.dropdown__*`) · **S** search-select (`searchSelect.js`,
> `.search-select__*`) · **O** omnisearch (`omnisearch.js`) · **T** segmented/chip
> (`.segmented`/`.chip`) · **D** delivery-window (`.dwin*`) · **X** bespoke.
> NOTE: `filters.js mountFilters` + `drawer.js mountFilterDrawer` are each mounted twice
> (Stats Filters popup + Graph Filters popup) — one design decision, listed once.

## Counts (distinct controls, dual-mounts counted once)
S 20 (30%) · N 16 (24%) · P 16 (24%) · T 7 (10%) · D 4 (6%) · O 2 (3%) · X 2 (3%) — **67 total**.
No absolute majority. By the owner's two camps: native-OS (N=16) vs custom-family (P+S+T+D+O = 49).
S is the largest single family AND the documented migration target (searchSelect.js, playerFilters.js,
graph.js comment trails all record deliberate moves native→S). P and S already share panel CSS
(`styles.css:507-517` groups `.dropdown__panel`/`.search-select__panel`/`.omnisearch__results`/`.columns-popover`).

## By surface (control · pattern · single/multi · file:line)

### Scope strip / "Search Conditions" (filters.js, dual-mount)
- Gender (Men/Women) · **N** · single · filters.js:860
- Discipline (Batting/Bowling) · **N** · single · filters.js:868
- Format · **P** · multi (min-1) · filters.js:876
- Team type · **P** · multi (min-1) · filters.js:893
- Date preset · **N** · single · filters.js:918
- Date From/To · native `<input type=date>` · filters.js:915

### Condition builder / Advanced Filters (drawer.js + drawerInnings.js, dual-mount)
- Delivery Phase · **D** chips · multi · drawerInnings.js:1160
- Delivery Over range / Ball range · **D** number inputs · range · drawerInnings.js:1203
- Delivery Player balls (First/Last N) · **D** + nested **T** edge · drawerInnings.js:1304
- Matchup (Vs) row · **N** (optgroups) · single · drawer.js:315
- Role group / detailed role / bowling-via-role · **N** ×3 · drawer.js:293,375
- Batting hand · **N** · drawer.js:302
- Bowling style · **N** · drawer.js:304
- Team / Opposition / Event / Venue · **S** · multi · drawerInnings.js:1556 / 2017 / 1911 / 1982
- Event→Season (nested) · **P** · multi · drawerInnings.js:1618
- R.Pos · Batting position · Fielding pos/kind/phase · **P** · multi · drawerInnings.js:279/195/450/466/482
- Result (+ nested Condition) · Toss result · Toss decision · Innings order · Stage · **P** · multi · drawerInnings.js:812/855/861/867/980
- Numeric operator (≥/≤/=/between) · **N** · single · drawer.js:878
- Numeric "Match All/Any" · **T** · drawer.js:906
- "+ Add condition" (adds singleton or metric) · **N** big optgrouped select · drawer.js:695,921

### Table toolbar (table.js, Stats)
- Player search · **O** · table.js:1591
- Column preset · **N** · single · table.js:1600
- Matchup Vs (toolbar-bonded) · **N** · single · table.js:1603
- Columns · **X** bespoke `.columns-popover` (own open/position code, `.btn` trigger) · multi · table.js:1609,2828

### Header
- Header player search · **O** · index.html:100 / main.js:853
- Stats/Graphs view · **T** · index.html:125 / main.js:237

### Player pop-up (playerPage/Popup/Filters.js)
- Batting/Bowling · **T** · playerPage.js:167
- Date From / To · **S** month picker · single · playerFilters.js:261/271
- Batting position · **P** · multi · playerFilters.js:156
- Against · Vs · **S** · single · playerFilters.js:281/291

### Player Graph Chooser modal (playerGraphChooser.js)
- Chart type · **T** tiles · single · :81
- Metric X / Y / single · **N** ×3 · single · :124/128/142

### Graphs builder panel (graph/graph.js)
- Chart type · **S** (was native, was tile grid) · :2587
- Bar style · Roster mode · **T** · :462 / :485
- "Add a player" · **X** bespoke typeahead (3rd search impl) · :492,2340
- Roster/candidate picker · **P** + ad-hoc filter `<input>` · multi · :499,2233
- Bar metric · Scatter X/Y · Radar metrics · Phase metric · Slope metric · Line X-dim/metric · Dumbbell metric · Benchmark anchor/metrics · **S** (14) · graph.js:1441..1842
- Slope/Dumbbell window dates · native `<input type=date>` ×8
- Graph filters popup · = Scope strip + Condition builder, 2nd mount · graph.js:2756/2763

## The mixes (same job, different language)
1. **Exclusive 2-way toggle:** mostly **T** (Stats/Graphs, player Batting/Bowling, Bars/Dots, First/Last, Match-All/Any, Chart-type) — outliers **Gender + Discipline scope strip = N**.
2. **Categorical filter in the builder:** mostly **P** — outliers **5 profile pickers (hand, bowling, role×3) = N**.
3. **Metric picker:** **S** in Graphs panel, **N** in "+ Add condition" menu + Graph Chooser modal (which hands into that same panel). Sharpest like-for-like mismatch.
4. **Type-to-search a name:** THREE impls — **O** (omnisearch), **S** (searchSelect), **X** (graph "add a player").
5. **Delivery Phase = D chips** while sibling small multi-selects = **P**.
6. **Dates:** native `input type=date` (scope/graph windows) vs **S** month-list (player pop-up) — day vs month granularity, a real affordance difference.
7. **Columns popover + Graphs roster filter:** bespoke re-implementations of P / S.

## Defensible-as-N (per auditor) vs must-converge
- Defensible today: numeric **operator** (4 fixed opts, no search; only one impl); Toss result/decision/Innings order/Team-type are inclusive 2-checkbox multi-selects, P fits.
- Clearly converge: Gender+Discipline (scope) → T; 5 profile pickers → panel; Graph-Chooser metric N vs Graphs-panel S; Phase chips vs P; the 3 search impls → 1; dates; Columns/roster bespoke.

## Dead code found (fold into the sweep)
- `.team-dropdown*` CSS (styles.css ~478-584) — 0 live JS refs (only a stale comment filters.js:759). Remnant of a picker already migrated to S.
- `playerSections.js monthOptionsHTML()` — no live call site (superseded by playerFilters.js S month picker).
