# Wave 6 polish — "drop impossible picks" extended from Stage to the other five lists

Branch: polish-b1-mechanical (from HEAD 1d0be9e) · Status: COMPLETE (verified on
localhost:8000 against the local export in `data/export/`; the `src/config.js`
override is the orchestrator's and is NOT committed).

## Problem
Cascading options stop an impossible combination being PICKED, but it stayed
reachable by DESELECTING: Venue = {Udayana, Bayuemas} → Stage offers Final
(Bayuemas hosted Finals) → pick Final → remove Bayuemas → Udayana + Final = 0
rows. `mountStage` already reconciled its own side; Venue/Event/Team/Opposition
had no equivalent, so the mirror-image case left a pick applied (0 rows) but
invisible in its own dropdown (the widget renders only loaded options).

## Approach + key risk
ONE shared pure helper, `reconcilePicks(cur, allowed, {sentinels, inactive})` in
`drawerInnings.js`, used by all of them; each picker keeps its OWN inactive shape
(`[]` for venue/event/teams/opposition, `[STAGE_ALL]` for stage — no new
sentinel). It returns `null` when nothing changed, so callers write only on a real
change — that is the convergence guard.

KEY RISK (Rule 1): a wrong drop would change a number. It cannot: every loader
(`searchTeams/searchEvents/searchVenues/searchEventSeasons/searchStages`) has NO
LIMIT and is called with an empty term (the term only reorders), so a loaded list
is the COMPLETE set for the current scope+siblings. A pick absent from it cannot
be satisfied by any in-scope match, i.e. it is a dead disjunct in its own IN-list
— removing it leaves the built query's result set identical (proved empirically
below). The only intentional result change is the ruled fallback: when NOTHING
survives, the filter reverts to "no narrowing" and results WIDEN.

## What changed (`src/drawerInnings.js` only)
- New shared `reconcilePicks()` + a header block on the rule, the numbers-safety
  argument and the convergence argument.
- `mountStage.reconcileSelection()` now calls it (behaviour identical — proved
  over 2,048 cases, below).
- `mountScopedMultiSelect` gains `reconcileSelection()`, run after a SUCCESSFUL
  option load (never after a failed one), before `handle.setValues`. Serves
  Venue / Event / Team / Opposition.
- New optional `config.onReconciled` hook; `mountEvent` passes
  `pruneOrphans() + seasons.sync()` so a reconciled-away event cannot leave orphan
  `eventSeasons` state (same follow-up a hand de-select runs).
- `mountEventSeasons.reconcileNarrowing()` unchanged — its `dataKey` already
  carries every sibling, so it already reacted; verified live (below).
- CURRENCY GUARD (all three loaders): reconcile only when the reply still matches
  the live cache key (`key === cacheKey()/scopeKey()/dataKey()`). Another picker's
  reconcile can land between a load being issued and its reply; reconciling
  against superseded options could drop a pick that is valid again. Observed
  firing in the wild (logged `load:Event=…(STALE-skip)` twice). Nothing is lost:
  `sync()` reloads for the new key and reconciles from that reply.

## Verified
- `node --check`: drawerInnings.js, filters.js, playerData.js, drawer.js, state.js
  — all pass. No instrumentation left (`grep -c TEMP-INSTR` = 0).
- BYTE-IDENTICAL: real `buildQuery` + `buildMatchupQuery` + graph-fetch SQL, 22
  filter states × 4 shapes, HEAD 1d0be9e vs working tree → IDENTICAL, sha256
  `69abe5930bc76ee379121fcb86d7d3238d13ca461d6f84f1aaa69f32d2224817` (135,283 B).
  Option-list SQL also identical (playerData.js untouched). A matchup+positions
  state (not in the 22) also identical.
- STAGE REFACTOR EQUIVALENCE: old vs new logic over 64 selections × 16
  vocabularies × 2 hidden-states = 2,048 cases, 0 mismatches.
- SCENARIO (a) live: Venue={Udayana, Bayuemas} → Stage offers {3rd Place Play-Off,
  Final, No Stage} → pick Final → the Venue list reloads 179→34 (the Final-hosting
  venues) and Udayana is DROPPED (toggle "2 venues" → "Bayuemas Oval"); remove
  Bayuemas → Venue = "Any venue", Stage stays Final, Search = **561 players**, top
  Waseem Muhammad 192 (4 inns) = independent SQL for stage=Final (561 batters, 192
  / 4). Udayana ∧ Final = 0 batters, i.e. the stranded state is gone.
  NOTE: the owner's scripted ending ("Stage reverts to All") no longer happens on
  this route — the pair is dissolved one step EARLIER. See Concerns 1.
- MIRROR-IMAGE DESELECT, one route per filter (Result Condition = {Normal, D/L},
  then Normal deselected — a fixed-vocabulary sibling that never reconciles):
  · VENUE: {Bayuemas, Tafawa Balewa Square} → list 179→**36** = independent SQL
    (36 D/L venues) → Tafawa (0 D/L) dropped, Bayuemas (5) KEPT. Search = **70
    players**, top Zeeshan Ali 70 = independent SQL; and both-venues ∧ D/L gives
    the SAME 70 → the drop moved no number.
  · VENUE fallback: {Tafawa} alone → nothing survives → Venue = [] ("Any venue",
    row gone). The intermediate lists were briefly EMPTY (Team 0 / Opposition 0 /
    Event 0 = the real 0-row state) and after the reconcile read 57 / 57 / 38.
    Search = **566 players**, top R Obuya 148 (3 inns) = independent SQL; the
    would-be stranded state (Tafawa ∧ D/L) = 0 batters.
  · EVENT: {ICC Men's T20 World Cup, West Africa Trophy} → list 210→**38** =
    independent SQL (42 raw D/L events → 38 canonical, WAT absent, WC present) →
    WAT dropped, WC kept.
  · TEAM: {South Africa, Japan} → list 105→**57** = independent SQL (57 teams in a
    D/L match) → Japan (0) dropped, South Africa (5) kept.
  · OPPOSITION: {West Indies, Japan} → list →**57** → Japan dropped, West Indies
    kept.
  · SEASON: Event = WC narrowed to {2025/26} → the season list reloads to 1
    (2024, the only D/L season) → `{WC:["2025/26"]}` → `{}` = "All seasons", and
    the sub-row hides (≤1 in-scope season, owner ruling) with no invisible filter
    left.
- CONVERGENCE (instrumented, then instrumentation removed): every scenario settles
  in ≤3 passes with EXACTLY ONE write; the following pass reconciles all lists and
  writes nothing. Counts: scenario (a) 12 loads / 1 write; venue deselect 8/1;
  venue fallback 8/1; event 3/1; team 3/1; opposition 4/1; season 3/1. No loop.
- ANCHORS (Men/T20/International, 2023-07-01→2026-07-02), on the COMMITTED file:
  2,813 players; Karanbir Singh 2,454; SA Yadav 60 inns / 1,544 runs / 29.13 /
  150.34; SA Yadav vs Spin 38 inns / 454 runs / SR 140.99 (spin BF 31.4% of 1,027
  ≈ 322, uncat 11.1% → coverage 913 of 1,027); JJ Bumrah vs Right-handers, striker
  positions 1–2 = 27 inns / 177 balls / 9 wkts, matching an independent
  matchup_bowling check exactly. ZERO console messages of any kind throughout.
- GRAPH VIEW: the same drawer over the buffer store reconciles identically
  (Venue={Udayana,Bayuemas} + Stage=Final → Udayana dropped, 3 loads / 1 write).

## Concerns (flagged, NOT resolved — owner calls)
1. **Scenario (a) now resolves one step earlier, by dropping the VENUE rather than
   the Stage.** Picking Stage = Final while Venue = {Udayana, Bayuemas} drops
   Udayana immediately (it is a dead disjunct), so by the time Bayuemas is removed
   there is nothing impossible left and Stage stays Final. Same guarantees (never
   0 rows, never a stranded pill) but NOT the ending the brief scripted
   ("Stage reverts to All"). That fallback still exists (it fires whenever a
   filter's last surviving option goes) — it is simply no longer what happens on
   this route.
2. **Per-value reconcile is LOSSY at pick time, by design of the briefed rule.**
   Because it is per-value and every list reconciles, a redundant-but-harmless pick
   is removed as soon as another filter makes it dead — Udayana above was dropped
   the moment Final was picked, and widening Stage back to All does not bring it
   back. Consequence: a multi-value combination whose support graph is not
   "connected" is now effectively UNREACHABLE through the UI (each intermediate
   single-value state prunes the other side). This is the emergent cost of the
   rule the owner ruled correct for Stage, applied everywhere; the owner has not
   seen it on Venue/Event/Team/Opposition. If it is unwanted, the alternative is
   all-or-nothing (drop only when a filter's ENTIRE selection is impossible), which
   would keep Udayana and revert Stage to All instead.
3. **The reconcile only runs while the Filters popup is OPEN** (that is when
   `drawer.sync()` runs, hence when option lists reload) — inherited from Stage.
   So removing a value via a table-area PILL × while the popup is closed can still
   leave an impossible pending state until Search. Unchanged by this task; fixing
   it would mean reconciling outside the drawer, i.e. new behaviour.
4. When a reconcile empties a filter, its drawer row disappears if it was not
   added in this popup session (`hasValue` presence rule) — exactly what happens
   when the user clears the filter by hand, but worth knowing: for Venue/Event/
   Team/Opposition the signal is the row/pill going, not an "All" label.
5. Not a defect, noted while reading numbers: a PINNED player's row deliberately
   bypasses leaderboard-only clauses (decision 47a), so Bumrah's PINNED row reads
   32 inns / 464 balls / 28 wkts (RHB, all positions) while the anchor row in the
   result set reads 27 / 177 / 9. Anchors must not be read off a pinned row.
6. `src/playerData.js` still contains the literal NUL byte noted in earlier passes
   (use `grep -a`).
