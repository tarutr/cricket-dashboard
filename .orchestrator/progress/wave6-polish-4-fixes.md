# Wave 6 polish — 4 owner UX fixes + the greying reversal (FIX 1/2/4/5) + FIX 6

Branch: polish-b1-mechanical (from HEAD 1bb4dc9) · Status: COMPLETE (verified on
localhost:8000 against the local export in `data/export/`; the `src/config.js`
override is the orchestrator's and is NOT committed).

## FIX 1 — a section collapses ONLY from its arrow
Owner problem: with a filter dropdown open you instinctively click beside it to
dismiss it, the click lands on the section header, and the whole section folds.
Both dropdown implementations dismiss on an outside click WITHOUT stopping that
click, so it reached the header — which was itself the toggle button.

- `index.html` / `src/graph/graph.js` — the header row is now a plain `<div>` of
  text; the chevron is a real `<button>` carrying `data-role="…-section-toggle"`,
  `aria-expanded`, `aria-controls` (Stats) and an `aria-label`. main.js's lookup
  by `data-role` is untouched; graph.js's body lookup changed from
  `toggle.nextElementSibling` to `toggle.closest('.filters-popup__section')
  .querySelector('.filters-popup__section-body')`.
- `styles.css` — header row loses its button reset + `cursor:pointer`; the
  chevron gains the button reset, a 2rem tap target, hover colour, and the
  rotate rule moves from `.filters-popup__section-header[aria-expanded=false]`
  to `.filters-popup__chevron[aria-expanded=false]`.
- The GRAPH Filters popup had the identical defect in its own copy of the same
  markup; fixed the same way (flagged in the report — same defect, same control).

Observed: with the Venue dropdown open, a real pointer click on the "Advanced
Filters" header row hit `DIV.filters-popup__section-header`, the dropdown closed
(1 open panel → 0), BOTH sections stayed expanded, the popup stayed open. A real
click on the arrow collapses/expands only its own section. Tab order inside the
panel is Close → "Show or hide Search Conditions" → that section's controls (the
same slot the old whole-row button held), and the chevron is a native `<button>`
so Enter/Space activation is the browser's, unchanged. Same three results in the
graph popup.

## FIX 2 — "Result Condition" now lays out through the SAME code path as Season
The two nested rows were near-copies that had drifted: Result Condition's picker
wraps its head+dropdown in one extra element (a `.filter-group`, whose in-popup
`gap` override made its label→dropdown gap 4px against Season's 8px), and the
long label pushed its dropdown past the right edge of the short "All results"
parent box, so it read as a separate row rather than a child.

- `styles.css` — `.result-condition .nested-pick { display: contents; }`
  dissolves that wrapper, so head + dropdown become direct flex children of the
  ONE shared `.event-seasons, .result-condition` rule. Plus one shared label
  column, `flex: 0 0 5.25rem`, on `.nested-pick__head, .event-seasons__head`:
  wide enough for "CONDITION" on its own line (the label wraps to two lines,
  owner-approved), so both children put their dropdown at the same x.

Observed (Men/T20/International, 2023-07-01 → 2026-07-02, Event + Result both
added): at 1280px both child rows are byte-for-byte the same geometry — child
block x=348 (12px in from the parent toggle at 336), label column w=84, child
dropdown x=440 w=144. The Result parent box is 336–480, so the child dropdown now
starts INSIDE it. At 380px: identical again (label x=36 w=84, dropdown x=128
w=144) and `documentElement.scrollWidth === 380` — no horizontal overflow.

## FIX 4 — ticked values pin to the top of their dropdown
Owner problem: a venue they had ticked kept sliding up and down as the
games-count ordering re-shuffled around it (a sibling filter change reloads the
list with a new order).

- `src/searchSelect.js` — `mountSearchMultiSelect` gains OPT-IN `pinSelected`
  (off by default, so graph.js's static metric/axis pickers are untouched).
  `applyFilter` partitions the option rows into ticked-first / rest, after the
  dead picks; `renderList` marks the last row of that block `.is-pin-last`.
- `src/drawerInnings.js` — `mountScopedMultiSelect` (Venue/Event/Team/Opposition)
  passes `pinSelected: true`; `mountAllMultiSelect` (Stage, Result, Result
  Condition) and `mountEventSeasons` (Season) grow the same block, between the
  dead picks and the rest.
- `styles.css` — one hairline (`.search-select__option--multi.is-pin-last`,
  `.dropdown__item.is-pin-last`); no colour, no extra spacing, so a list with
  nothing ticked looks exactly as before.

### JUMPINESS CHOICE (report this)
The pinned block is a **SNAPSHOT, frozen while the panel is open**. It is taken
when the panel opens and again whenever a fresh option list lands, and nothing
else invalidates it — in particular a tick/untick never does. So:
  · ticking a value while the panel is open does NOT move it (it just gets a
    tick where it already sits) — no row is ever yanked out from under the
    cursor mid-click, and the "least-jumpy" instruction is satisfied absolutely;
  · un-ticking a pinned value leaves it in place, un-ticked, for the rest of
    that open session;
  · re-opening the dropdown (or any option reload) re-asserts the rule: the
    newly-ticked value joins the block; the un-ticked one drops back to its
    games-count position.
The alternative — moving a row the instant it is ticked/unticked — was rejected:
it shifts every row between the old and new position, so a second click at the
same spot hits a different value.

Observed (Venue, 179 in-scope grounds, games desc): ticked the 152nd row
("Shaheed Veer Narayan Singh International Stadium, Raipur", 2 games) → it stayed
at index 151 while the panel was open. Close + reopen → index 0, pinned, hairline
under it, the other 178 unchanged in games order. Then added Team = India: the
venue list reloaded 179 → 43 and completely re-ordered, and the pick was STILL
row 0 (the owner's exact complaint). Un-ticked it → on reopen it is back at index
16 of 43, no block, no hairline. Stage behaves identically (ticked Final +
Semi-Final: no movement while open; on reopen both sit under "All stages" with
the hairline after Semi-Final, the other 8 keeping A–Z). Season identically
(ticked 2023, the oldest/last: no movement while open, index 1 on reopen).

## FIX 5 — a dead-end selection greys out; it is NEVER rewritten (owner ruling)
Reverses the previous pass's whole-selection reset. `reconcilePicks()` and all
three call sites (`mountScopedMultiSelect.reconcileSelection`,
`mountStage.reconcileSelection`, `mountEventSeasons.reconcileNarrowing`) are
GONE — no option-list load writes state any more. The `allowed`/dead computation
stays and now feeds DISPLAY only (`keepMissingSelected`, `deadSpecifics()`,
`deadSeasons()`), plus the FIX 6 notice. `config.onReconciled` went with them
(dead code once nothing reconciles); mountEvent's `pruneOrphans()` still runs on
a real event edit, unchanged.

- INVISIBLE-PICK GUARANTEE: `mountStage`'s `hiddenWhen` is now
  `nothingToChoose() && !hasStagePick()` — the `!namedOptions ||` term is gone,
  so a control holding a pick renders even while its vocabulary is still
  loading (it briefly lists only "All stages", then fills in). Season already
  had this via `visibleEvents()`.
- CONVERGENCE is now trivial: no reconcile writes, so the
  load → reconcile → reload cycle no longer exists. Confirmed empirically: held
  the dead-Season state and watched the whole Filters popup with a
  MutationObserver — **0 mutations in 6 seconds**.
- `grep -a "reconcilePicks\|reconcileSelection\|reconcileNarrowing\|onReconciled"
  src/*.js` = 0 hits.

Observed — THE OWNER'S EXACT CASE. Venue = Tafawa Balewa Square Cricket Oval,
Lagos (22 games) alone, then Result Condition = D/L (Rain):
  · the venue pick is KEPT (toggle still reads the venue; no reset, no widening
    to 566 players), the Venue row stays on screen, and the venue dropdown shows
    it at the top ticked + greyed with "no matches with your current filters"
    (37 live grounds below it);
  · Search → **0 players**, both pills intact (`Venue: …`, `Result condition:
    D/L (Rain)`), and the table area carries the explanation (FIX 6b);
  · clicking the greyed row un-ticks it → Search → **566 players**, top R Obuya
    148 — exactly the number the previous pass's independent SQL gave for "D/L,
    no venue".

Observed — THE STAGE CASE WHERE THE CONTROL WOULD OTHERWISE HIDE. Stage =
{Final, Semi-Final}, then Result Condition = Awarded (the scope holds exactly one
Awarded match, at Udayana Cricket Ground, with `event_stage IS NULL` — verified by
independent SQL). The Stage vocabulary collapses to 0 named + "No Stage" = 1
option, i.e. `nothingToChoose()`, which used to hide the control AND reset the
picks:
  · the dropdown RENDERS ("2 selected"), listing "All stages", then Final and
    Semi-Final both greyed with the note, then "No Stage";
  · Search → 0 players, pill `Stage: Final, Semi-Final`;
  · un-ticking both greyed rows restores the ≤1-option hide rule (dropdown
    hidden, note "No tournament stages to choose in this scope.") and Search →
    4 players — the batters from that single Awarded match.

Observed — THE SEASON CASE. Event = ICC Men's T20 World Cup — Europe Qualifier
narrowed to season 2023, then the TOOLBAR date moved to 2025-01-01 → the event
survives, the {2023} narrowing does not: it is KEPT, rendered greyed at the top
of the Season dropdown above the live 2026/2025, pill reads `Event: … (2023)`,
Search → 0 players.

## FIX 6 — telling the user the search will come back empty
### (a) In the Filters popup — a notice, never a block
Detection is FREE and deterministic, with no COUNT query: when a cascading
filter's ENTIRE selection is currently unavailable, that filter alone provably
empties the result set. Each cascading picker already knows this from its own
loaded option list, and now exposes `deadReport() -> {label, values} | null`
(`mountScopedMultiSelect`, `mountStage` via `mountAllMultiSelect.deadReport`,
`mountEventSeasons`; `mountEvent` returns whichever of its two halves is dead).
A load changes no state, so nothing would otherwise prompt a refresh — hence the
new `onOptionsLoaded` callback threaded from drawer.js through mountTeam /
mountOpposition / mountEvent / mountVenue / mountStage.

- `index.html` + `src/graph/graph.js` — a notice band between the scrolling body
  and the footer, so it is on screen whatever you have scrolled to.
- `src/drawer.js` — `syncEmptyNotice()` (called from `sync()` and from
  `onOptionsLoaded`) composes the text. `src/main.js` / graph.js hand in the
  element. Search is NEVER disabled.
- `styles.css` — `.filters-popup__notice` (+ `-main` / `-hint`): caution band on
  `--color-bad-bg`, headline in `--color-bad`, muted hint.

EXACT WORDING (one dead filter):
  headline · `No matches: your Venue selection (Tafawa Balewa Square Cricket
             Oval, Lagos) has no games once your other filters are applied.`
  hint     · `You can still press Search — it will just come back with nothing.
             To get results, untick the greyed-out value in that list, or loosen
             your other filters.`
Several dead filters read `your Venue selection (…); and your Stage selection
(…) have no games once…` and the hint pluralises to "values in those lists".
Each filter lists at most 3 of its values, then ", and N more".
Only the five cascading filters report — the fixed-vocabulary pickers (Result,
Toss result / decision, Innings order, Batting position) have no cross-filtered
list and cannot go dead this way.

### (b) In the table area — explanatory text for every other empty result
`src/table.js`'s body hint SAID, before this pass: **"No players match these
filters."** — true but it neither explains nor suggests anything. Now:
  `No players match these filters. Nothing in the data meets all of your filters
   and conditions at the same time — open Filters and remove or loosen one, or
   widen the date range.`
`styles.css` caps `.table-body-hint` at 46rem and centres it with line-height
1.5 so two sentences read as a paragraph, not a stretched line. No popup for this
case, per the owner.

Observed: (1) Tafawa + D/L → greyed pick kept AND the notice names Venue; Search
works and the table shows the explanation. (2) zero rows from a STAT condition
(Runs ≥ 99999) → NO notice in the popup, only the table text. (3) a normal
non-empty search (2,813 / 566 / 4 players) shows neither. The graph Filters
popup (same shared drawer) shows the identical notice.

## Verified
- `node --check`: drawerInnings.js, searchSelect.js, drawer.js, main.js,
  table.js, graph/graph.js — all pass. `src/playerData.js` untouched (its literal
  NUL byte still there; `grep -a`).
- **BYTE-IDENTICAL (Rule 1)**: a node harness emits every SQL string the app
  builds — real `buildQuery` (which dispatches `buildMatchupQuery`),
  `buildScopeClauses`, `buildCoreScopeClauses`, `buildMatchContextClauses`,
  `matchContextJoinSql`, the five exported predicate builders,
  `buildFieldingSliceClauses` / `buildFieldingCteSql` / `buildPomCteSql`,
  `pinnedIdSetSql`, the SEVEN playerData loaders, the nine player-popup
  fetchers, and the graph fetchers (`fetchCareerGames`,
  `fetchSelectedPlayerMetrics`, `fetchWindowMetric`, `fetchLineData`,
  `fetchBenchmarkPool`) — over 32 filter states × 4 matchup settings ×
  batting+bowling × 4 column sets, with db.js stubbed to capture SQL.
  HEAD 1bb4dc9 vs working tree: **IDENTICAL**, 4,552 emitted blocks, sha256
  `e05393b739a42b3937780b0761805c817a7a6e81c9ba4bd0e488426eba334455`
  (2,439,109 B). Emitted SQL covers every view: matches, batting, bowling,
  fielding, player_matches, matchup_batting, matchup_bowling.
  `git diff --name-only` (excluding the orchestrator's own config override and
  BACKLOG.md) = index.html, styles.css, src/drawer.js, src/drawerInnings.js,
  src/graph/graph.js, src/main.js, src/searchSelect.js, src/table.js.
- **ANCHORS**, read off the RESULT SET (never a pinned row — decision 47a), Men /
  T20 / International, 2023-07-01 → 2026-07-02: **2,813 players**; row #1
  Karanbir Singh **2,454** runs; SA Yadav at row #11 = **60 inns / 1,544 runs /
  29.13 avg / 150.34 SR**. Matchup batting (Vs = Spin): SA Yadav row #11 = **38
  inns / 454 runs / SR 140.99**, Pace 57.5% + Spin 31.4% of 1,027 balls →
  coverage **913 of 1,027**. Matchup bowling (Vs = Right-handers, Team = India,
  striker positions 1–2): JJ Bumrah = **27 inns / 177 balls / 9 wkts**.
- ZERO console messages of any kind across the whole session (Stats + Graphs).

## Concerns (flagged, NOT resolved — owner calls)
1. **The graph Filters popup was changed too.** It carries its own copy of the
   same section-header markup and had the identical FIX 1 defect, and it mounts
   the same shared drawer, so it also gets the FIX 6 notice band. Not named in
   the brief; fixing only the Stats popup would have left the two inconsistent.
2. **Stage's ≤1-option hide rule now yields to a pick even while loading.** The
   brief made the invisible-pick guarantee critical, so `hiddenWhen` no longer
   defers to "vocabulary not loaded yet". Cost: during a reload, a Stage control
   that holds a pick shows for a moment with only "All stages" in its list (its
   toggle label is correct throughout). Before this pass the same moment hid the
   control and flashed the "nothing to choose" note instead.
3. **A Season/Stage dead state is only reachable by the routes cascading allows**
   (the previous pass's concern 1 stands): the option lists cross-filter each
   other, so you cannot tick a value the current combination already excludes.
   The dead states above were reached via the fixed-vocabulary Result Condition
   and via a TOOLBAR date change, both of which bypass cascading legitimately.
4. **The empty-result notice only reports the CASCADING filters.** A zero-row
   result from a stat condition, or from a combination where each filter is
   individually satisfiable, gets the table-area text only — that is the owner's
   ruling, but it means the popup is silent for the majority of empty results.
5. **Un-ticking the LAST value in a multi-select still removes the whole drawer
   row** (the pre-existing `hasValue` presence rule), and the open portaled panel
   is briefly left floating. Pre-existing, unchanged, cosmetic.
6. **Reconcile-adjacent inheritance**: option lists still only (re)load while the
   Filters popup is OPEN (previous pass's concern 5), unchanged.
