# Pin exemption, part 2 — "a pin changes WHO is listed, never WHAT their numbers mean"

Branch: polish-b1-mechanical (from HEAD 1996905) · Status: COMPLETE (verified on
localhost:8000 against the local export in `data/export/`; the `src/config.js`
override is the orchestrator's and is NOT committed).

Extends `.orchestrator/progress/pin-exemption-scope.md`. That pass made the bypass
set explicit and fixed Event / Venue / Stage / Result / Result-Condition / Toss /
Innings-Order. Two of the five remaining bypassables described MATCHES or BALLS
rather than PLAYERS, so a pinned row still answered a different question from every
other row. This pass fixes those two, and gives the Graph Builder the same policy.

## The test now applied to every clause
Does the clause describe the PLAYER ("who counts as a candidate") or the MATCHES /
BALLS being measured? Player → pin-bypassable. Matches/balls → ALWAYS applies.

## CHANGE 1 — `opposition` now applies to pins
`src/filters.js`, `buildScopeClausesTagged`: the opposition clause is a bare string
(always-applies) instead of `bypassableClause(...)`. "Innings against Australia"
selects matches, not players.
Visible effect: pinned SA Yadav under Opposition = Australia read his career
**60 inns / 1,544 runs**; it now reads the honest **10 / 259**.

## CHANGE 2 — the matchup STRIKER position now applies to pins
Same function: the `includePositions` / `state.positions` clause
(`batting_position IN (...)`, matchup-only — `positionsFilterActive` gates on
`matchupVsActive`) is a bare string now. It selects BALLS: the striker's position in
matchup_bowling, the batter's own position on that ball in matchup_batting.
**`state.regularPositions` (R. Pos.) stays `bypassableClause`** — it is a player
attribute ("their usual slot"), owner-ruled bypassable, untouched.
Visible effect: pinned Bumrah vs RHB / Team India / striker positions 1–2 read
**32 inns / 464 balls / 28 wkts** (all positions); it now reads **27 / 177 / 9**.

## CHANGE 3 — the Graph Builder treats a pin exactly as the Stats table does
`src/graph/charts.js` `fetchSelectedPlayerMetrics` (plain branch — the matchup branch
already routes through `buildQuery` and so was already correct):
- `buildScopeClauses` → `buildScopeClausesTagged`
- the charted-roster clause `idCol IN (playerIds)` is pushed UNTAGGED = always-applies
  (it is not a user filter, it IS the chart; an uncharted pin must never leak in)
- match-context clauses stay untagged, as before
- `WHERE` now goes through the SHARED `whereWithPinExemption(whereClauses, idCol, pins)`
  — deliberately not a second copy of the policy, so the two can never diverge.
Only `team` is bypassable on this path (`profile` / `R. Pos.` need an `idColumn` this
caller does not pass — pre-existing, unchanged).
Visible effect: with `teams:['Australia']` and SA Yadav pinned + charted, the graph
returned **no row at all**; it now returns him with his own **60 / 1,544**.

## Final bypassable set (exactly five)
1. **team** — "plays for India" (player attribute)
2. **player profile** semi-join — role / hand / bowling style
3. **R. Pos.** semi-join — the player's usual batting slot
4. **the name search** — tagged at each `src/table.js` call site
5. **the numeric stat conditions** — `gateWithPinExemption`, post-aggregation, untouched

Always-applies: core scope (gender / format / date window / team type), **opposition**,
**matchup striker position**, event (+ per-event seasons), venue, and the whole Wave-6
match-context family (result, result condition, stage, toss result, toss decision,
innings order).

Comment blocks updated to state the WHO-vs-WHAT principle and the five: above
`buildScopeClausesTagged` and above the pin-exemption helpers in `src/filters.js`;
the four bypass-set recitals in `src/table.js`; `src/main.js`'s omnisearch doc;
`src/state.js`'s `pinnedPlayers` field comment. No SQL change from any comment edit.

## Verified

### Independent SQL (DuckDB CLI over `data/export/*.parquet`, outside the app)
Shape deliberately unlike the app's: the qualifying MATCH set is enumerated first and
INNER JOINed, innings counted as a `COUNT(*)` over a `SELECT DISTINCT match_id,
innings_number` subquery, where the app uses FILTER-ed aggregates and
`COUNT(DISTINCT match_id || ':' || innings_number)`.

Men / T20 / International, 2023-07-01 → 2026-07-02 (day-bounded).

| Check | Independent SQL | App (screen / real buildQuery) |
|---|---|---|
| SA Yadav, all opposition | 60 inns / 1,544 runs / 1,027 BF / 53 outs | 60 / 1,544 (the anchor) |
| SA Yadav vs **Australia** | **10 / 259** / 155 BF / 9 outs → avg 28.78, SR 167.10 | **10 / 259 / 28.78 / 167.10** |
| SA Yadav NOT vs Australia | 50 / 1,285 | partition: 10+50 = 60, 259+1,285 = 1,544 ✓ |
| Bumrah vs RHB, Team India, striker pos **1–2** | **27 inns / 177 balls / 9 wkts / 200 runs** | **27 / 177 / 9 / 200** |
| same, **all striker positions** | **32 / 464 / 28 / 500** | = the wrong pinned figure before this change |
| balls/wkts/runs partition | 177+287 = 464, 9+19 = 28, 200+300 = 500 ✓ | |
| SA Yadav catches, Event = ICC Men's T20 WC + Venue = Kensington Oval | 2 `caught` + 0 `caught and bowled` = **2** (whole scope = 24) | chart bar = **2** |
| D Wiese, same slice | 2 `caught` + 1 `caught and bowled` = **3** | chart bar = **3** (leader) |
| SA Yadav matchup coverage | total BF 1,027, mapped **913**, Spin BF 322, Spin runs 454 | **913 of 1,027**; 38 inns / 322 / 454 / SR 140.99 |

### In-app, hand-written SQL (`import('/src/db.js')`) — the before/after pair
Not the app's aggregation shape: plain `SUM`/`COUNT` over the view with the OLD
predicate (`(filter) OR id IN (pins)`) vs the NEW one (`filter` outside the OR).

- SA Yadav, opposition: NEW `{inns:10, runs:259, bf:155, outs:9}` · OLD `{inns:60, runs:1544, bf:1027, outs:53}`
- Bumrah, striker position: NEW `{inns:27, balls:177, wkts:9, runs:200}` · OLD `{inns:32, balls:464, wkts:28, runs:500}`

### Through the app's REAL builders + real DuckDB (`table.buildQuery`)
| State (pin = SA Yadav) | rows | SA Yadav |
|---|---|---|
| opposition = Australia, **no pin** | 214 | 10 / 259 / 28.78 / 167.10 |
| opposition = Australia, **PINNED** | 214 | **10 / 259 / 28.78 / 167.10** (was 60 / 1,544) |
| regularPositions = 1,2 **no pin** | 570 | ABSENT |
| regularPositions = 1,2 **PINNED** | 571 | **60 / 1,544 / 29.13 / 150.34** — appears, bypass retained |
| teams = Australia **no pin** | 36 | ABSENT |
| teams = Australia **PINNED** | 37 | **60 / 1,544 / 29.13 / 150.34** — appears, bypass retained |
| matchup: Vs RHB + Team India + striker pos 1,2, **no pin** | 26 | Bumrah 27 / 177 / 9 / 200 |
| matchup: same, Bumrah **PINNED** | 26 | Bumrah **27 / 177 / 9 / 200** (was 32 / 464 / 28) |

### Through the real `fetchSelectedPlayerMetrics` (the changed graph function)
Charted roster = [SA Yadav, Karanbir Singh (Austria)].
- no filters (control): both returned — SA Yadav 60 / 1,544 / 150.34, Karanbir 51 / 2,454 / 175.29
- `teams:['Australia']`, **no pin**: **zero rows** (the defect — a deliberately charted player vanishes)
- `teams:['Australia']`, SA Yadav **PINNED**: **SA Yadav 60 / 1,544 / 150.34**; Karanbir still ABSENT
  (merely selected, not pinned → obeys the team filter, as required)
- Event + Venue (4 Kensington Oval aliases), SA Yadav **PINNED**: catches **2**, D Wiese **3** —
  the previous pass's fielding fix does not regress.

### ON SCREEN (localhost:8000, 1280×900)
- Stats, no pins: **2,813 players**, #1 Karanbir Singh **2,454**, SA Yadav #11 =
  **64 mat / 60 inns / 1,544 runs / 29.13 / 150.34** (reproduced twice, before and
  after a Clear).
- Matchup batting (Vs = Spin), no pins: SA Yadav #11 = **38 inns / 322 BF / 454 runs /
  SR 140.99 / 64.86 avg**, Pace 57.5% + Spin 31.4% + Uncat 11.1% → coverage 913 of 1,027.
- Matchup bowling (Vs = Right-handers, Team = India, Batting position = 1, 2), no pins:
  **JJ Bumrah #4 = 27 inns / 177 balls / 9 wkts / 200 runs**.
- Same state with **Bumrah PINNED**: row floats to the top, rank still #4, numbers
  **27 / 177 / 9 / 200** — unchanged from his unpinned row.
- Opposition = Australia, **SA Yadav PINNED**: row #1, **10 mat / 10 inns / 259 runs /
  28.78 / 167.10**, pin glyph `is-pinned`.
- Graph, Bar / Runs, graph filter **Team = Australia**, SA Yadav pinned: chart
  "Runs — 15 most-capped players · Team: Australia" draws **SA Yadav 1,544** next to
  MR Marsh 1,215, TM Head 990, TH David 937, GJ Maxwell 679 … — every other bar an
  Australian; the non-Australians that were in the roster before the filter are gone.
- Graph, Bar / **Catches**, graph filter **Event = ICC Men's T20 World Cup + Venue =
  Kensington Oval, Bridgetown, Barbados**, SA Yadav pinned and added to the roster:
  **SA Yadav 2**, D Wiese 3, DA Warner / PD Salt / GJ Maxwell / MS Wade / MA Starc 2,
  the rest 1. No 24-catch bar.
- **ZERO console messages of any kind** across the whole session (Stats + Graphs).
- `node --check`: filters.js, table.js, graph/charts.js, main.js, state.js — all pass.

### BYTE-IDENTICAL WITH NO PINS (Rule 1)
Node harness (`scratchpad/pinfix/`, extended this pass so the graph fetchers run over
ALL 38 filter states rather than the first 10): emits every SQL string the app builds
— `buildQuery` (which dispatches `buildMatchupQuery`), `buildScopeClauses`,
`buildCoreScopeClauses`, `buildMatchContextClauses`, `matchContextJoinSql`, the five
exported predicate builders, `buildFieldingSliceClauses` / `buildFieldingCteSql` /
`buildPomCteSql`, `regularPositionCteSql`, `pinnedIdSetSql`, `playerScopeClauses`, the
option-list loaders, the player-popup fetchers and the graph fetchers
(`fetchSelectedPlayerMetrics`, `fetchWindowMetric`, `fetchLineData`,
`fetchBenchmarkPool`, `fetchCareerGames`) — over **38 filter states × 4 Vs settings ×
batting+bowling × 4 column sets**, `db.js` stubbed to capture SQL.

HEAD `1996905` vs working tree: **IDENTICAL** — 5,970 emitted blocks, 3,034,055 B,
sha256 `435405761746cb4d57ec4b1d5347cabf49d731d496e3e567be9ba369f4bc79de`.

With `PINS=1` (two pins on every state): **188 of 5,970 blocks differ**, all of them
`buildQuery` (120, only the opposition- and positions-active states),
`fieldingCte` (24, the opposition-active states — the fielding CTE carries opposition
too) and the graph fetchers. Sample, matchup_batting with striker positions 1–2:

    HEAD  … AND ((batting_position IN (1, 2)) OR batter_id IN ('p-sky','p-two'))
    WORK  … AND batting_position IN (1, 2) AND (TRUE OR batter_id IN ('p-sky','p-two'))

and the graph, `teams:['India','Australia']`:

    HEAD  … AND batting_team IN ('India','Australia') AND batter_id IN ('p1','p2')
    WORK  … AND batter_id IN ('p1','p2') AND ((batting_team IN ('India','Australia'))
              OR batter_id IN ('p-sky','p-two'))

The `(TRUE OR …)` group when nothing bypassable is active is HEAD's own shape for that
case (`whereWithPinExemption` already emitted it in `buildQuery`); the graph now shares
it. Semantically a no-op.

## Also fixed
Nothing beyond the brief — no defects tripped over this pass.

## Concerns (flagged, NOT resolved — owner calls)
1. **More pinned numbers change on screen.** Intended, but worth the owner knowing: a
   pinned row under an Opposition filter, or under the matchup Batting-position filter,
   now reports the filtered figure, not the career one. Any saved screenshot of such a
   row is now a different number. The standing anchors have no pins and did not move.
2. **`state.pinnedPlayers` are seeded into the graph's charted roster.** Observed while
   verifying: applying Team = Australia reseeded the roster to "15 of 37 selected" —
   36 Australians + the pinned SA Yadav — so a pin is added to the chart as well as
   exempted within it. That behaviour is pre-existing (`graph/players.js` seeding) and
   is what makes CHANGE 3 visible, but it is a product choice worth an explicit ruling:
   should pinning in the Stats table also add the player to every chart?
3. **The Graph card's scope line still does not name Event / Venue / Team-scope
   qualifiers consistently.** The Team = Australia chart appended "Team: Australia",
   but the Event + Venue chart's subtitle read only "Men's T20s (international),
   Jul 2023 – Jul 2026" even though the chart honours both. Pre-existing display gap
   (also raised by the previous pass); the numbers are right, the caption is silent.
4. **There is no way to pin a player who is absent from the current result set.** The
   header omnisearch suggestion opens the player POPUP (decision 32) rather than
   pinning, so the only pin affordance is the row's pin toggle. Every "pinned player
   the filter excludes" check therefore has to be staged: search unfiltered, pin from
   the row, then narrow. The pin also does not survive the drawer's own "Search" in
   every path (it survived the toolbar Search). Pre-existing; noting it because it makes
   the pin feature hard to reach for exactly the case it exists for.
5. Pre-existing, unchanged, and re-observed: the drawer's "Remove condition" and the
   toolbar filter pill's "×" did not always clear the filter on the first click during
   verification (R. Pos. survived both once); Escape closes the whole drawer, not just
   an open multi-select popover.
