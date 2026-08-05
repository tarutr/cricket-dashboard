# T-2e — Matchup "Vs" filter (Option A) + Batting-position slice + MAT confirm (progress)

Branch `ball-layer`, main working tree. NO git (orchestrator commits). Numbers-sacred (Rule 1).
Wiring the LAST two withheld Tab-2 filters into the pop-up Filters tab.

## Plan (grounded in code)
### 1. Matchup "Vs" — Option A (owner-signed-off)
- Row gains `matchupVs` field ({dim,value}). `buildRowState` sets `rowState.matchupVs` → `buildQuery`
  ALREADY dispatches to `buildMatchupQuery` (matchupVsActive) → outer-wrap `SELECT * FROM (…) WHERE id='X'`.
  buildMatchupQuery UNCHANGED (numbers sacred). matchesSql is null for matchup, so the existing wrap works.
- Default plain batting cols (matches/innings/runs/average/strike_rate/high_score/fours/sixes) ALL resolve in
  matchup_batting ns → tab renders them from the matchup output by shared key. Plain-only cols (balls_faced,
  ducks, not_outs, 50s, 100s…) have no matchup_batting twin → render "—" (display gap, NOT a numbers error).
- A-constraint: matchup-Vs row combines with SCOPE singletons only (team/opp/event/venue/stage/match+toss
  result/innings number — buildMatchupQuery honors via buildScopeClauses/buildMatchContextClauses); NOT with
  per-innings slices NOR ball predicates (vs_opp/window — buildMatchupQuery ignores them → would be silently
  wrong). Enforced HONESTLY via `popupLock` gating in the palette.
- Men-only (matches leaderboard `!women` gate). NOT ballOn-gated: matchup views exist flag-off; the leaderboard
  vs family is men-only, not ball-engine-gated. (Brief's "ball-engine-gated" parenthetical is imprecise — the
  tab is flag-on regardless; flagged in report.)

### 2. Batting position — LIST multi-select, batting-only, per-innings SLICE
- New condition shape {metricKey:"batting_position", positions:[…]} → inningsWhere `batting_position IN (…)`.
- Palette leaf "Batting position" (popup + batting + not matchup-locked). Editor renders a 1..11 checkbox list.

### 3. MAT for matchup rows
- buildMatchupQuery computes "matches" as COUNT(DISTINCT match_id) FILTER(bucket) — a real matchup metric.
  "matches" is in the tab's default plain cols → merged into visibleColumns → resolves in matchup_batting →
  correct MAT (matches the player faced that bucket). No buildMatchupQuery change needed.

## popupLock model (editor-computed, palette-enforced)
- null (empty row): offer everything (per-innings metrics + batting pos + matchup-Vs + ball preds + scope).
- "matchup" (draft.matchupVs set): offer ONLY scope singletons (hide metrics/batting-pos/ball-preds/matchup-Vs).
- "slice" (≥1 cond OR ball pred): hide matchup-Vs; offer metrics/batting-pos/ball-preds/scope.

## Files to change
- src/paletteGroups.js — popupLock param + gates; matchupVsFamily (un-withhold "vs" on popup); Batting position leaf.
- src/playerFilterEditor.js — draft.matchupVs; matchupVs row (display+remove); vsBowlingTypes loader; pickSingleton
  "vs" intercept; batting_position condition (add/render/clean); popupLock compute + rebuildPalette; commit.
- src/playerFiltersTab.js — row.matchupVs; buildRowState matchupVs; row label (matchup); batting_position slice
  (conditionToInningsWhere/isSliceConditionComplete/labels/baseName).
- src/table.js — export orderBowlingTypes (pure display helper; NO numbers) for the editor's fine-types ordering.

## Status: COMPLETE + VERIFIED (flag-off R2, browser + independent DuckDB)
- node --check all 4 JS OK. config.js untouched (git-clean). table.js diff = ONLY `export orderBowlingTypes`
  (buildQuery/buildMatchupQuery/conditionToHaving BYTE-UNTOUCHED). Leaderboard palette (surface leaderboard)
  byte-identical (matchupVsFamily → singleFamily for non-popup).
- Leaderboard anchors: 2,813 players / Karanbir 2,454 / SA Yadav 64·60·1,544·29.13·150.34 (on screen).
- Leaderboard Vs=Spin (no-regression + cross-ref): SA Yadav 38 inns / BF 322 / 454 runs / SR 140.99 / avg 64.86 / dis 7.
- INDEPENDENT DuckDB (SKY=271f83cd, Men/T20/Intl, 2023-07-01→2026-07-02 day-bounded):
  - baseline 60 inns / 1,544 / 53 outs (29.13) / SR 150.34.
  - matchup vs Spin: 38 inns / 454 runs / SR 140.99 / MAT 38 / avg 64.86 (7 dis) / 4s 41 / 6s 15 / HS 47 / BF 322.
  - batting pos {3,4}: 56 inns / 1,518 / 49 outs (30.98) / SR 151.35 / MAT 56 / 4s 140 / 6s 79 / HS 100.
- TAB rows on screen == the above EXACTLY:
  - "vs Spin"  → MAT 38, INNS 38, RUNS 454, AVG 64.86, SR 140.99, HS 47, 4S 41, 6S 15  (== leaderboard Vs).
  - "Batting position: 3, 4" → MAT 56, INNS 56, RUNS 1,518, AVG 30.98, SR 151.35, HS 100, 4S 140, 6S 79.
  - "No conditions" → MAT 64, INNS 60, RUNS 1,544, AVG 29.13, SR 150.34, HS 100, 4S 142, 6S 80 (byte-identical).
- A-constraint (on screen, both directions):
  - matchup-Vs row → palette offers ONLY scope (Team / Opposition / Event / Venue / Stage / Match+Toss Result /
    Innings Number). No metrics / batting-pos / PotM(Y/N) / matchup-Vs family / ball predicates.
  - slice row (batting position) → palette DROPS the Matchup (Vs) group; slices + scope still offered.
- MAT: matchup row MAT=38 (buildMatchupQuery's own COUNT(DISTINCT match_id) FILTER bucket — correct, no change
  needed). batting-position row MAT=56 (inningsLevel via inningsWhere — correct).
- 0 JS console errors. (Only 2 resource 404s = favicon.ico, which the repo has never shipped — environmental,
  pre-existing, not a JS exception.)
- Fine bowling-type variants load flag-off (Off-spin / Leg-spin / … appear in the vs bowling style family).
- node --check all 4 touched files OK.
- Verification chosen FLAG-OFF (R2): the matchup anchor (SKY vs Spin 38/454/SR140.99) is a
  production/full-dataset number → the LOCAL ball snapshot (a subset) can't reproduce it, and
  matchup views + batting_position exist on the R2 innings parquets (leaderboard Vs mode + R.Pos
  work flag-off). The tab per-row query runs directly vs R2 flag-off (T-2c verified). So NO
  config.js edit / range-server needed. Opponent/window (flag-on-only) are unchanged here.

## Files changed (final)
- src/paletteGroups.js — popupLock param + 3 gates; matchupVsFamily (un-withhold "vs" on popup,
  offered only on empty row); leafMetric/PotM(Y/N) hidden on matchup row; Batting position leaf
  (popup+batting+!matchup); vs_opp + Ball Ranges hidden on matchup row. Leaderboard byte-untouched.
- src/playerFilterEditor.js — draft.matchupVs; matchup-Vs row (bucket <select> + ×); vsBowlingTypes
  loader; pickSingleton "vs" intercept + preselectMatchupVs→setMatchupVs; batting_position LIST
  cond (add/render/clean); popupLock compute + rebuildPalette; scopeController onChange→relock;
  commit passes matchupVs + belt-and-braces mutual exclusion.
- src/playerFiltersTab.js — row.matchupVs (makeRow/openEditor/commit); buildRowState matchupVs;
  matchupVsLabel + rowAllLabels; batting_position slice (conditionToInningsWhere / complete / labels
  / baseName).
- src/table.js — export orderBowlingTypes (pure display helper; no numbers).
- styles.css — .pfe-cond--positions / __positions / __poschk / --matchupvs.
