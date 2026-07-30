# Wave 3 (ENGINE HALF) — delivery-window predicate engine

Branch `ball-layer`. Owner: decision 67 (window semantics) + `.orchestrator/ball-layer-design.md`.
NO UI this wave (drawer comes later after owner design sign-off). Numbers-critical.

## What shipped
- **NEW `src/deliveryWindow.js`** — the window-spec → ball-predicate generator (pure).
  `deliveryWindowPredicate(spec, discipline)`:
  - `team {mode:'phase', phases:[...]}` → `phase IN (...)` (canonical pp/mid/death order,
    whitelist literals — no injection). VERIFIED format-native against data/wave1_out: T20
    pp=ov0–5/mid=6–14/death=15–19; ODI pp=ov0–9/mid=10–39/death=40–49; The Hundred
    (bpo=5) pp=team_ball1–25/mid=26–75/death=76+; **red ball phase IS NULL** (phase window
    matches nothing → consistent with UI "red = Overs only"); super-over rows NULL phase.
  - `team {mode:'overs', from,to}` → `over_number BETWEEN from-1 AND to-1` (over 1 = 0-based 0).
  - `team {mode:'balls', from,to}` → `team_ball BETWEEN from AND to` (legal-ball ordinal).
  - `player {edge:'first'|'last', n}` → batting/matchup_batting `bat_ball`/`bat_ball_rev`
    BETWEEN 1 AND n; bowling/matchup_bowling `bowl_ball`/`bowl_ball_rev`. Discipline picks the clock.
  - team + player compose with AND. `null`/`{}` → **""** (the no-window invariant).
  - Malformed ACTIVE specs THROW (numbers-critical, fail loud); documents valid format×mode
    combos (gating is a UI concern, not enforced here). `describeDeliveryWindow()` label helper.
- **`src/state.js`** — added the ONE nullable field `deliveryWindow: null` (default) to
  createInitialState. Nothing else touched.
- **`src/db.js`** — threaded the window through the engine path:
  - `setDeliveryWindow(spec)` (exported) + `activeDeliveryWindow` module var + `windowPredicateFor(discipline)`.
    db.js is state-free (no store singleton), so the UI wave pushes `state.deliveryWindow` here from a
    store subscription; the seam/tests drive it directly.
  - `ensureEngineScope` computes the per-discipline `windowPredicate`, puts it in the cache
    `engineSignature` key AND passes it to `materialize`; the plan step carries it so
    `rebuildEngineFull` KEEPS the window (it defines the numbers) while dropping only pruning +
    player-scope. `widenForPendingQueries` signature gains the window (constant per discipline).
  - **null window ⇒ windowPredicate "" ⇒ key "" + SQL unchanged ⇒ byte-identical to today.**
- **`src/ballEngine.js` / `src/ballEngineMatchup.js`** — comments only. The `windowPredicate`
  hook was already wired into `baseWhere` (Wave 2a/2b); revisited the ROW-SET RULE to state
  the window is the DELIBERATE row-set exception (lands in the base ball CTE → crease union /
  matchup grain run over the in-window balls → innings with ≥1 in-window ball). No SQL change.
- `src/ballColumns.js` — untouched (all window columns already in DELIVERY_COLUMNS).

## ROW-SET handling (the critical bit)
Window lands in the base CTE `b`'s WHERE (baseWhere), before the crease union / aggregation, so
it INTENTIONALLY changes the row set to the in-window balls. It reads SOURCE columns in the WHERE,
so it needs no lean-projection entry — and column pruning (which only drops OUTPUT columns) CANNOT
defeat it (proven: case f pruned == full). Distinct from pruning's "columns only, never rows".

## VERIFICATION (native DuckDB over data/wave1_out — decision-39 independent)
- **No-window SQL identity**: `buildInningsViewSql/buildMatchupViewSql` with `windowPredicate=""`
  == without the arg — **7/7 identical** across all 4 disciplines + full/pruned/phase column sets.
- **Anchors from the ENGINE, window=null**: leaderboard **2,813** · Karanbir **2,454** · SA Yadav
  plain **60/1,544/1,027/53 → 29.13/150.34** · SKY vs Spin **38/454/322 → SR 140.99** · Bumrah vs
  RHB pos 1–2 **27/177/9**. All reproduce.
- **8 windowed cases — engine (got) == independent raw-ball (expected), 0 mismatch** (Men/T20/
  Intl/2023-07-01→2026-07-02, SKY unless noted):
  | case | inns | runs | balls | dis | avg | SR |
  |---|---|---|---|---|---|---|
  | (a) death (phase) | 13 | 185 | 96 | 9 | 20.56 | 192.71 |
  | (b) overs 1–6 | 41 | 465 | 337 | 16 | 29.06 | 137.98 |
  | (c) team-balls 1–36 | 41 | 465 | 337 | 16 | 29.06 | 137.98 |
  | (d) first-10 faced | 60 | 634 | 476 | 26 | 24.38 | 133.19 |
  | (e) last-10 faced | 60 | 709 | 476 | 52 | 13.63 | 148.95 |
  | (f) first-10 ∧ death | 11 | 25 | 14 | 4 | 6.25 | 178.57 |
  - (b)==(c): T20 6 overs == 36 legal balls — two window modes describing the same set agree.
  - (d) SR 133.19 == the shipped first-10 progression SR (SA Yadav) — the player clock reproduces it.
  - (g) death vs Spin (matchup): **4 inns / 26 runs / 13 balls / SR 200.0, coverage 78 of 96** — engine==independent.
  - (h) Bumrah first-6-bowled (bowling clock): **32 inns / 192 balls / 176 runs / 11 wkts / econ 5.5** — engine==independent.
  - Column-pruned (f) == full (f): pruning cannot defeat the window.
- **Innings-count semantics** all satisfy decision-67's "≥1 in-window ball" (engine == independent
  crease-union count). NOTE case (f): engine inns **11** but "SKY FACED ≥1 in-window ball" = **4**.
  The 7 extra innings are ones where SKY was at the crease (non-striker/dismissed) on an in-window
  ball without facing one himself — inherent to the per-STRIKER `bat_ball` clock composed with a
  team window. Faithful to decision 67's literal rule + the brief's "crease union over windowed
  balls is correct"; his runs/balls/SR are unaffected (bat CTE sums only his faced balls). FLAGGED
  for the design/UI wave + owner (a cricket-semantics judgment — NOT changed here).
- **Extras attribution spot-check** (decision 67): a death-overs over with a FOUR at team_ball 101
  then a WIDE — the wide carries team_ball **102** (the UPCOMING legal slot, shared with the
  re-bowled legal ball), NOT 101. So `team_ball BETWEEN 1 AND 101` includes the four but EXCLUDES
  the wide; `1 AND 102` includes both. Matches the shipped `legal_ordinal` attribution.

## Browser (flag ON, localhost:8000) — see report
node --check clean on all touched files. Anchors on screen + 0 console errors flag ON/OFF + timings.

## Gotchas for successors / the UI wave
- db.js reads the window via `setDeliveryWindow(spec)` (no store singleton). The UI wave must call
  `db.setDeliveryWindow(store.get().deliveryWindow)` from a store subscription (and on graph/popup
  buffer stores if those get their own window).
- Gating (decision 67) is NOT enforced in deliveryWindow.js — the UI enforces: Phase+Balls only
  T20/50-Over; Overs all formats (only mode for red ball); player clock all formats.
- The case-(f) innings-count semantics above is an OPEN owner-facing question, not a bug.
- Harness in scratchpad: `gen_harness.mjs` (engine, real generators+pruning) + `independent.sql`
  (hand-written different-shape) + `anchors.sql`; run from data/wave1_out via duckdb CLI.
