# Wave 6 polish — ALL-OR-NOTHING reconcile + a dead pick stays visible

Branch: polish-b1-mechanical (from HEAD 26be026) · Status: COMPLETE (verified on
localhost:8000 against the local export in `data/export/`; the `src/config.js`
override is the orchestrator's and is NOT committed).

## Problem (owner-confirmed, reproduced live)
Cascading OPTION lists are offered with OR-logic across your picks: Venue =
{Mission Road, Gelephu} makes the Stage list offer `Final` (Mission Road hosted
Finals) AND `Semi-Final` (Gelephu did). But the KEEP test judged each picked
value on its own (AND-logic): tick `Final` and Gelephu — which contributes
nothing *while Final is the only stage* — was deleted, and reconcile only ever
removed, so ticking `Semi-Final` afterwards left Gelephu gone. Net effect: the
legitimate "either venue AND either knockout round" query (5 real matches in the
anchor scope) was unbuildable in that click order, and the app's answer depended
on the order the form was filled in. The offer test and the keep test now use the
SAME standard.

## Approach + key risk
1. `reconcilePicks()` becomes ALL-OR-NOTHING: at least one non-sentinel picked
   value still in the freshly-loaded list → return `null` (no write, nothing
   dropped); zero survivors → the filter's own `inactive` shape (`[]` for
   venue/event/teams/opposition, `[STAGE_ALL]` for stage — the ruled fallback,
   unchanged). The changed-only write guard is untouched.
2. Because a pick can now outlive its own option list, every picker renders a
   surviving-but-currently-impossible value as an extra row at the TOP of its
   dropdown: ticked, muted, annotated `no matches with your current filters`
   (ONE shared constant `DEAD_PICK_NOTE`), and clickable so it can be un-ticked
   (once un-ticked it disappears — it is not a real option). UNTICKED irrelevant
   options stay HIDDEN; the narrowed list is never re-expanded.

KEY RISK (Rule 1): keeping a dead pick must not move a number. It cannot — a
loader's list is the COMPLETE set for the current scope+siblings (no LIMIT; the
search term only reorders), so an absent pick is a dead disjunct in its own
IN-list and the result set is identical with or without it. Proved twice below,
in-app AND by independent SQL.

## What changed
- `src/searchSelect.js` — `mountSearchMultiSelect` gains OPT-IN
  `keepMissingSelected` + `missingNote`. Off by default, so graph.js's radar/metric
  pickers are untouched. On: `setValues`/`setOptions` stop pruning unknown
  selected values; `missingSelected()` derives synthetic rows (only after
  `setOptions` has landed once, so a slow first load never paints the selection
  dead); they lead the filtered list, render inside the widget (not through the
  caller's `renderRow`, which has no data for them), carry `.is-missing`, are
  never `isRowDisabled`, and `toggle()` re-applies the filter so an un-ticked
  dead row vanishes instead of staying re-tickable. `selectedValues()` returns
  dead picks first, then options order.
- `src/drawerInnings.js`
  - `reconcilePicks()` rewritten (all-or-nothing) + the header block rewritten
    (why order-dependence existed, why keeping a dead pick is numbers-safe, why
    it still converges).
  - New shared `DEAD_PICK_NOTE`.
  - `mountScopedMultiSelect` (Venue/Event/Team/Opposition) opts into
    `keepMissingSelected`.
  - `mountAllMultiSelect` gains `deadSpecifics()` + `valueOrder()` + an optional
    `optionsReady` gate; renders dead boxes between "All" and the live options,
    and orders writes dead-first so an unrelated tick can't silently drop one.
  - `mountStage`: `hiddenWhen` is now `nothingToChoose() && (!namedOptions ||
    !hasStagePick())` — the ≤1-option hide rule can no longer swallow a control
    that is actively filtering; `optionsReady: () => namedOptions !== null`;
    `reconcileSelection` uses the REAL option list as `allowed` (no longer
    ∅-when-hidden), so a pick that matches a one-item list survives.
  - `mountEventSeasons`: `hasNarrowing()`, `deadSeasons()`; `visibleEvents()` also
    shows an event that IS narrowed (never hide a control that is filtering);
    `reconcileNarrowing()` is all-or-nothing per event and no longer intersects,
    no longer collapses on `isFull`, and no longer deletes for ≤1 in-scope season;
    `setEventSeasons`' isFull collapse now also requires the selection to contain
    no dead value; the season change-handler orders `[...dead, ...inScope]`.
- `styles.css` — `.dropdown__item--dead` + `.dropdown__item-note`, and
  `.search-select__option--multi.is-missing` (+ its meta). Recolor-only
  (`--color-muted`), matching the app's one disabled language, but interactive
  (pointer cursor kept); the note wraps to its own line so a narrow panel never
  grows sideways.

## Verified
- `node --check`: drawerInnings.js, searchSelect.js — pass. No instrumentation
  left (`grep -a "TEMP-INSTR\|__RC"` = 0).
- BYTE-IDENTICAL: a node harness emits every query string the app builds — real
  `buildQuery` (which dispatches `buildMatchupQuery`), `buildScopeClauses`,
  `buildMatchContextClauses`, the five exported predicate builders, the fielding/
  PoM CTEs, and the six option-list loaders (db.js stubbed to capture SQL) — over
  31 filter states × batting+bowling × 4 column sets. HEAD 26be026 vs working
  tree: **IDENTICAL**, sha256
  `d3a2073c7da2c761d83bf74dc4807ac08eed62a9942dfe42658bb04332d51ff3` (333,913 B).
  Re-run after removing instrumentation: still identical. `git diff --name-only`
  = drawerInnings.js, searchSelect.js, styles.css only.
- **ORDER-INDEPENDENCE, both orders, same answer** (Men/T20/International,
  2023-07-01 → 2026-07-02):
  · Order A — Venue = {Mission Road Ground Mong Kok; Gelephu International} →
    tick Stage = Final → Venue toggle STAYS "2 venues", the list narrows 179→34
    and Gelephu renders at the top ticked+greyed with the note → tick Semi-Final
    → list grows to 40, the grey clears (Gelephu 2 games, Mission Road 3) →
    Search = **89 players**, top Nizakat Khan 81 (1 inn), then Basir Ahamad 80,
    R Sandaruwan 63, AP Yadav 62, TP Ura 61.
  · Order B — Stage = {Final, Semi-Final} first, then both venues → Search =
    **89 players**, identical top five.
  · Independent SQL (own shape, day-bounded, over `matches` + `batting_innings`):
    the combination is **5 matches**, **89 distinct batters**, top Nizakat Khan
    81 / Basir Ahamad 80 / R Sandaruwan 63 / AP Yadav 62 / TP Ura 61. EXACT match.
  · Option-list counts independently confirmed: 34 venues host a Final in scope,
    40 host a Final or a Semi-Final. The UI showed 34 live + 1 dead row, then 40.
- **A DEAD PICK MOVES NO NUMBER** (Rule 1), in-app and by SQL:
  · Venue = {both} + Stage = Final (Gelephu dead) → **56 players**, top Nizakat
    Khan 81. Un-tick the greyed Gelephu row → Venue = Mission Road only → Search
    → **56 players**, top Nizakat Khan 81. Identical.
  · Independent SQL: Mission Road ∧ Final = 56 batters; BOTH venues ∧ Final = 56
    batters.
  · Season path: Event = Continental Cup narrowed to {2025, 2026} + Stage = Final
    (2025 has no Final → dead, 2026 survives) → **19 players**, Omid Mailk Khel
    43 / J Fernando 38 / T Sandaruwan 31. Independent SQL for {2025,2026}∧Final
    and for {2026}∧Final: both 19 batters, same top three.
- **GREYED ROW IS INTERACTIVE**: clicking the greyed Gelephu row un-ticks it and
  the row vanishes; the toggle drops to the single venue name and the pill
  updates. Same for Stage (greyed Semi-Final un-ticked → gone, toggle "Final").
- **WHOLE-SELECTION-DEAD STILL RESETS**: Venue = {Tafawa Balewa Square Cricket
  Oval, Lagos} (0 D/L matches) + Result Condition = D/L → Venue snaps back to
  "Any venue", the row stays on screen with the placeholder, no stranded pill,
  and results WIDEN to **566 players**, top R Obuya 148 (3 inns), Karanbir Singh
  138, Shaheryar Butt 129 — exactly the independent SQL for D/L with no venue.
  Mirror case: Venue = {Gelephu} left alone with Stage = Final (reached by
  un-ticking Mission Road) resolves the other way — **Stage** snaps back to "All
  stages" and Gelephu survives. Either way: no zero-row strand, no stranded pill.
- **UNTICKED OPTIONS STAY HIDDEN**: with Stage = Final the venue dropdown shows
  34 live grounds + 1 dead row = 35 (not all 179 greyed out).
- **CONVERGENCE** (temporary instrumentation, then removed): keep-branch — tick
  Stage = Final with two venues picked = **2 option loads, 0 reconcile writes**,
  quiescent. Reset-branch (venue) — Tafawa + D/L = **2 loads, exactly 1 write
  (`venue -> []`)**, still quiescent 3 s later. Reset-branch (stage) — un-tick
  Mission Road leaving Gelephu ∧ Final = **4 loads, exactly 1 write
  (`stage -> ["all"]`)**, quiescent. No loop in any scenario.
- **ANCHORS**, read off the RESULT SET (never a pinned row — decision 47a):
  2,813 players; Karanbir Singh 2,454; SA Yadav 60 inns / 1,544 runs / 29.13 /
  150.34. Matchup batting: SA Yadav vs Spin = 38 inns / 454 runs / SR 140.99,
  Pace 57.5% + Spin 31.4% of 1,027 balls → coverage 913 of 1,027. Matchup
  bowling: JJ Bumrah vs Right-handers, striker positions 1–2 = **27 inns / 177
  balls / 9 wkts** (leaderboard row #1 under Team = India), matching an
  independent `matchup_bowling` check exactly.
- **GRAPH VIEW**: the Graph Builder's own Filters drawer (same components over
  the buffer store) behaves identically — Venue = {Mission Road, Gelephu} +
  Stage = Final keeps "2 venues" and renders the greyed Gelephu row with its
  note; and with Team = India the cascade correctly offers no Gelephu at all.
- ZERO console messages of any kind throughout.

## Concerns (flagged, NOT resolved — owner calls)
1. **The brief's scripted first step is unreachable as written.** "Venue =
   {Gelephu} alone → tick Stage = Final" cannot be clicked, because cascading
   (correctly) does not offer Final for a venue that never hosted one. The same
   dead-selection state was reached by the routes cascading does allow (both
   venues → Final → un-tick Mission Road; and the fixed-vocabulary Result
   Condition route), and both behave as intended.
2. **A one-option Stage list now renders when it holds a pick.** The owner ruled
   "≤1 option is nothing to choose from → hide the control". That still holds
   when Stage is on "All", but a control that is actively filtering is no longer
   hidden — otherwise the pick would be invisible and (under all-or-nothing)
   permanent. Same change for a narrowed Event → Season dropdown with ≤1 in-scope
   season. This is a small extension of a ruled behaviour and the owner has not
   seen it; if unwanted, the alternative is to keep deleting those picks, which
   reintroduces exactly the order-dependence this task removes.
3. **The app has ONE palette.** `styles.css` has no dark block and no
   `prefers-color-scheme` / `[data-theme]` rule, so "reads correctly in light and
   dark" could not be verified as shipped. The new styling uses only the theme
   variables (`--color-muted`, `--color-accent`), and a temporary dark palette
   swapped in at runtime rendered the dead rows correctly (muted label, italic
   note, accented tick). It will follow any future dark palette for free.
4. **Un-ticking the LAST value in a multi-select still removes the whole drawer
   row** (the pre-existing `hasValue` presence rule), and the open portaled panel
   is briefly left floating at the top-left because its host row has gone.
   Pre-existing, unchanged, cosmetic.
5. **Reconcile still only runs while the Filters popup is OPEN** — inherited,
   unchanged (see the previous pass's concern 3).
6. `src/playerData.js` still contains the literal NUL byte noted in earlier
   passes (use `grep -a`).
