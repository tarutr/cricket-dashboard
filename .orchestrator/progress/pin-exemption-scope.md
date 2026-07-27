# Pin-exemption narrowing + Radar/Benchmark picker group headers

Branch: polish-b1-mechanical (from HEAD 380c581) · Status: COMPLETE (verified on
localhost:8000 against the local export in `data/export/`; the `src/config.js`
override is the orchestrator's and is NOT committed).

## PART 1 — the pinned-player bypass set is now EXPLICIT, not positional

### The defect
`whereWithPinExemption(fullClauses, coreClauses, idColumn, pins)` split the WHERE
list by POSITION: `core AND (fullClauses.slice(coreClauses.length) OR id IN pins)`.
So **every filter appended to `buildScopeClauses` after the pin exemption was
written silently joined the bypass list** — `event` (+`eventSeasons`), `venue`, and
all five Wave-6 match-context filters (`result`, `resultCondition`, `stage`,
`tossResult`, `tossDecision`, `inningsOrder`). None of those was ever ruled
bypassable. HEAD's emitted SQL, captured by the harness below:

    WHERE gender = 'male' AND match_type IN (…) AND match_date >= … AND team_type = …
      AND ((match_id IN (SELECT match_id FROM matches WHERE … event_name IN (…)))
           OR batter_id IN ('p-sky'))       <-- event bypassed for the pin

### The fix
Classification now travels WITH each clause, and **always-applies is the default**.

- `src/filters.js`
  - New tagging primitives: `alwaysClause(sql)`, `bypassableClause(sql)`,
    `asTaggedClauses(list)` (a bare string normalises to `bypassable: false`),
    `clauseSqlList(list)`.
  - `buildScopeClausesTagged(state, opts)` is the real builder and returns
    `{sql, bypassable}[]`. Exactly five clauses opt in via `bypassableClause`:
    **team, opposition, batting/striker position, profile semi-join, R. Pos.
    semi-join**. Core scope, event/venue and everything else are bare strings =
    always-applies.
  - `buildScopeClauses(state, opts)` is now `clauseSqlList(buildScopeClausesTagged(…))`
    — same clauses, same order, so every existing caller and every emitted string
    is unchanged.
  - `whereWithPinExemption(clauses, idColumn, pins)` — the `coreClauses` argument is
    GONE. Emits `always AND (bypassable OR id IN (pins))`, bypassable collapsing to
    `TRUE` when nothing bypassable is active (HEAD's own shape for that case, kept).
    Guarded so an empty always-group can't emit a leading " AND ".
  - `buildCoreScopeClauses`' doc comment no longer claims to be the pin boundary.
  - `gateWithPinExemption` (the HAVING / matchup step-3 stat-condition gate) is
    UNCHANGED — stat conditions remain pin-bypassable.

**WHY A FUTURE FILTER CANNOT SILENTLY JOIN THE BYPASS SET:** a clause pushed as a
bare string is always-applies. Becoming pin-bypassable now requires typing
`bypassableClause(...)` on purpose. The rule is stated in a comment block directly
above `buildScopeClausesTagged`.

- `src/table.js` — all five call sites moved to the tagged list; the name search is
  tagged `bypassableClause` at each, and `buildMatchContextClauses` output is pushed
  untagged (always-applies):
  `buildQuery`, `buildMatchupQuery`, `buildFieldingCteSql`, `buildPomCteSql`, and the
  `player_matches` "matches" secondary query. The three `full.slice(core.length)`
  reconstructions are gone. `buildScopeClauses` is no longer imported here (unused).
- `src/graph/charts.js` — **untouched, deliberately.** `fetchSelectedPlayerMetrics`
  never called the helper: it applies the full scope to every selected id and then
  restricts with `idCol IN (playerIds)`. The 24-catches bug reached it through the
  SHARED `buildFieldingCteSql` / `buildPomCteSql` it attaches, so the fix propagates
  there with no edit. Verified with a focused HEAD-vs-work emit (below).

### "—" for a pin with no rows in the filtered scope
No new machinery was needed — `floatPinsToTop` (table.js) already synthesises a
`__noData` placeholder row for a pin absent from the result set, and
`missingPinnedIds` → `main.js reportPinCoverage` already toasts. The row reads:

    [active red pin] | — | SA Yadav | — | — | — | — | — | — | — | —

i.e. the rank cell and EVERY stat cell are em dashes, the pin glyph is
`is-pinned`, and a one-time toast says **"SA Yadav has no innings in this scope"**.
Row order/float unchanged.

## PART 2 — group headers on the two multi-select metric pickers
- `src/searchSelect.js` — `mountSearchMultiSelect.renderList` now honours the same
  opt-in `group` field `mountSearchSelect.renderList` already did (track `prevGroup`,
  emit `.search-select__group` on change when truthy). Headers carry no `data-idx`,
  so `filtered` indexing, arrow-key nav, `isOptionDisabled` cap/floor logic, checkbox
  toggling and the `is-missing`/`is-pin-last`/`is-selected` classes are untouched.
  **Guard:** headers are suppressed for `i < pinnedRowCount` — the `pinSelected` block
  reorders rows by selection, so a header inside it would repeat later for the same
  group. Radar/Benchmark pass no `pinSelected` (`pinnedRowCount === 0`), so they
  behave exactly like the single-select; the drawer's pinning pickers pass no
  `group`. The two options compose.
- `src/graph/graph.js` — the Radar (~1422) and Benchmark (~1715) pickers now use
  `metricSelectOptions(eligible)` (= `metricGroups.groupedMetricOptions` with
  `metricDisplayLabel`), the same helper the seven single-selects use.
  Benchmark's `onChange` now re-derives `benchmarkMetricKeys` from `eligible`
  (catalogue order) instead of taking `vals` raw — before grouping those were the
  same array; this keeps the stored value byte-identical rather than letting it
  drift to grouped order. (Nothing downstream depended on it: the drawn rows already
  re-derive catalogue order and the reseed key sorts.)

## Verified

### Independent SQL (DuckDB CLI over `data/export/*.parquet`, outside the app)
Shape deliberately unlike the app's: the matches are enumerated first and INNER
JOINed, where the app uses a LEFT JOIN sub-select aliased `mctx` / non-correlated
`match_id IN (SELECT …)` semi-joins.

| Check (Men / T20 / International, 2023-07-01 → 2026-07-02) | Independent SQL | On screen (pinned row) |
|---|---|---|
| SA Yadav, all result conditions | 60 inns / 1,544 runs | 60 / 1,544 (the anchor) |
| SA Yadav + Result Condition = **D/L** | **2 / 82** | **2 / 82** (was 60 / 1,544) |
| SA Yadav + Result Condition = **Normal** | **56 / 1,442** | **56 / 1,442** |
| SA Yadav + Result Condition = **Super Over** | **2 / 20** | **2 / 20** |
| partition check | 56 + 2 + 2 = **60** ✓ | |
| SA Yadav catches, Event = ICC Men's T20 WC + Venue = Kensington Oval | **2** (whole scope = **24**) | Bar chart = **2** |
| same scope, field | D Wiese 3, then 2s and 1s | chart identical |
| SA Yadav batting, same event+venue | 1 mat / 1 inns / 3 runs | 1 / 1 / 3 |

The catches figure was ALSO recomputed inside the app through
`import('/src/db.js').then(m => m.query(…))` with hand-written SQL over `fielding` +
`matches`: `SA Yadav 2, D Wiese 3, CJ Jordan 1` — exactly the drawn bars.

### Retained bypasses (must NOT regress)
- **Team = Australia** (37 Australian batters) + pinned SA Yadav → he STILL appears,
  with his full-scope **60 / 1,544** (team is bypassed, as ruled).
- **Team = Australia AND Runs ≥ 99999** → 0 non-pinned rows; the pinned SA Yadav is
  the only row ("1 player"), 60 / 1,544. Stat-condition bypass
  (`gateWithPinExemption`) intact.

### "—" row
Venue = Udayana Cricket Ground (80 games, 163 players; SA Yadav never played there —
confirmed by independent SQL) + pinned SA Yadav → row present at the top, red active
pin, rank `—`, all eight stat cells `—`, toast "SA Yadav has no innings in this
scope". Before this pass the same state showed 64 / 60 / 1,544.

### BYTE-IDENTICAL WITH NO PINS (Rule 1)
Node harness (`scratchpad/pinfix/`, extended from the previous pass's): emits every
SQL string the app builds — real `buildQuery` (which dispatches `buildMatchupQuery`),
`buildScopeClauses`, `buildCoreScopeClauses`, `buildMatchContextClauses`,
`matchContextJoinSql`, the five exported predicate builders,
`buildFieldingSliceClauses` / `buildFieldingCteSql` / `buildPomCteSql`,
`regularPositionCteSql`, `pinnedIdSetSql`, `playerScopeClauses`, the option-list
loaders, the player-popup fetchers and the graph fetchers — over **38 filter states
× 4 Vs settings × batting+bowling × 4 column sets**, with `db.js` stubbed to capture
SQL.

HEAD `380c581` vs working tree: **IDENTICAL** — 5,858 emitted blocks, 2,968,493 B,
sha256 `04dd77f54860ea162eeab14aabf48462add1e4495fff85a111d8618310db8958`.

With `PINS=1` (two pins on every state) the same harness shows **672 of 5,802 block
tags changed, all in `buildQuery` / `fieldingCte` / `pomCte`** — the pin-exemption
paths only. States with just a bypassable filter active (e.g. `teams`) are
unchanged, confirming the retained bypasses are untouched.

### ANCHORS — read off the RESULT SET, never a pinned row (0 pins in the table)
Men / T20 / International, 2023-07-01 → 2026-07-02:
- **2,813 players**; row #1 Karanbir Singh **2,454** runs; SA Yadav at row #11 =
  **60 inns / 1,544 runs / 29.13 avg / 150.34 SR**.
- Matchup batting (Vs = Spin): SA Yadav row #11 = **38 inns / 322 BF / 454 runs /
  SR 140.99**; Pace BF 57.5% + Spin BF 31.4% of 1,027 balls → coverage **913 of 1,027**.
- Matchup bowling (Vs = Right-handers, Team = India, striker positions 1–2):
  JJ Bumrah row #4 = **27 inns / 177 balls / 9 wkts**.

### PART 2 verification
- Metric SET unchanged, checked in node for **4 namespaces × 4 format sets × both
  pickers = 32 combinations**: same keys AND same labels, zero duplicates, order only.
  Counts (batting/T20): Radar **29 → 29**, Benchmark **28 → 28**; bowling/T20 both
  **27 → 27**; matchup_batting/T20 Radar 18, Benchmark 17; matchup_bowling/T20 both 21.
- Headings render in drawer order, **non-empty groups only**: Radar and Benchmark on
  batting/T20 show `Basic metrics · Advanced metrics · Fielding · Impact` (no
  "Dismissal type" — batting dismissal COUNTS have `higherIsBetter: null`, so both
  pickers' pre-existing eligibility already excluded them); bowling/T20 shows all
  five. First row under each heading: Basic→Runs, Advanced→Dot Ball %,
  Fielding→Catches, Impact→Player of the Match.
- `data-idx` is contiguous 0..n-1 with headers interleaved, at every state tested.
- **Arrow-key nav skips headers**: nine ArrowDowns walked idx 1→9, crossing the
  "Advanced metrics" header between idx 6 and 7; no `.search-select__group` ever
  gained `.is-active`.
- **Radar cap**: at 10 selected, all 19 unchecked rows `is-disabled`, 0 checked rows
  disabled, note "Up to 10 metrics — untick one to swap.", toggle "10 of 29 metrics".
- **Benchmark floor/cap**: at 4 → all 4 checked rows disabled, 0 unchecked disabled;
  at 12 → all 16 unchecked disabled, 0 checked disabled. Headers (4) and `data-idx`
  intact at every step.
- A Radar chart (10 metrics, 4 players, 2 excluded no-data) and a Benchmark chart
  ("DA Warner vs the field", 8 metrics) both render. Radar axes stay in catalogue
  order (Runs, HS, Avg, SR, BPD, Dot%, Bdry%, BPB, 4s, 6s).

- `node --check`: filters.js, table.js, searchSelect.js, graph/graph.js — all pass.
- **ZERO console messages of any kind** across the whole session (Stats + Graphs).

## Also fixed
- Dropped the now-unused `buildScopeClauses` import from `src/table.js`.

## Concerns (flagged, NOT resolved — owner calls)
1. **A pin's numbers CHANGE on screen.** This is the point of the task, but it is
   worth the owner knowing: any saved screenshot of a pinned row under an
   event/venue/result/stage/toss/innings filter is now a different number. The
   standing anchors have no pins and did not move.
2. **The graph's `fetchSelectedPlayerMetrics` gives pins NO exemption at all** — a
   pinned player there obeys team / opposition / position / profile like everyone
   else, unlike the Stats table where those are still bypassed. Pre-existing
   asymmetry, untouched by this pass (touching it would change more numbers than the
   brief authorises). Worth an owner ruling.
3. **The pin PILL and its "(no innings)" annotation are dead code.** `pills.js`
   accepts `getNoInningsIds` for signature stability and `void`s it, and no pin pill
   is rendered any more (the pin COLUMN replaced it). So the only no-data-pin signal
   is the toast — which is transient. Pre-existing; the brief's requirement (a
   visible row with dashes) is met by the row itself.
4. **A zero-row result WITH a pin shows both a dashed row and "No players match
   these filters."** — the body hint keys off `lastRows.length === 0` (the query
   result), while the synthetic pin row is added at render time, and the count slot
   reads "0 players" while one row is painted. Pre-existing (reachable before this
   pass via a core-scope-empty pin), and not reached in any verification above,
   which all had a non-empty field. Cosmetic, but now easier to reach.
5. **Popup Search resets pins (owner ruling R5-B #3), toolbar Search keeps them.**
   Every verification above therefore had to apply the filter FIRST, press the popup
   Search, and pin afterwards. Not a defect — noting it because it makes "pin, then
   add a filter" impossible through the popup, which is the natural order a user
   would try.
6. **The Graph card's scope line does not name Event / Venue** ("Men's T20s
   (international), Jul 2023 – Jul 2026" only), even though the chart honours them.
   Pre-existing display gap, unrelated to this change; noticed while verifying the
   catches chart.
7. Pre-existing, unchanged: un-ticking the LAST value in a drawer multi-select
   removes the whole row and leaves the portaled panel briefly floating.
