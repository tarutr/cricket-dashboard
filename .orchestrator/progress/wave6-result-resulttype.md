# Wave 6 polish — Result / Result Type redesign + Stage scope (FIX A/B/C)

Branch: polish-b1-mechanical (from HEAD 1143403) · Status: COMPLETE (verified on
localhost against the local Wave-6 export in data/export/; config override reverted to R2).

## Approach + key risk
All additive, display-/UX-only. The KEY RISK was Rule 1 (numbers-sacred): the
match-context clauses live in `buildMatchContextClauses` (filters.js), gated by
`matchContextActive` (state.js), and consumed by buildQuery / buildMatchupQuery /
graph-fetch. The whole design hinges on making "All" a NO-NARROWING sentinel so
that `resultFilterActive`/`resultTypeFilterActive` return false for All-only —
which keeps `matchContextActive` false, so NO LEFT JOIN and NO clause are added,
and the emitted SQL stays byte-identical. Proven byte-identical (identical sha256).

## FIX A + B — Result + nested Result Type (replaces standalone "Rain-affected matches")
- state.js: RESULT_OPTIONS gains a leading "All" (RESULT_ALL). New RESULT_TYPE_OPTIONS
  (All / Normal / D/L (Rain) / VJD (Rain) / Awarded / Fewer Wickets) + `resultTypeMethod`
  token→raw-method map. `resultFilterActive` / new `resultTypeFilterActive` treat an
  All-only (or empty) selection as INACTIVE. `matchContextActive` now reads
  resultTypeFilterActive. state.method → state.resultType (default []). describeScope:
  Result drops the All sentinel from its label; new "Result type: …" token.
- filters.js buildMatchContextClauses: Result clause skips RESULT_ALL. Method block
  (5b) replaced by the Result Type block — All → nothing; Normal → `mctx.method IS NULL`;
  specific tokens → `mctx.method IN (...)` via resultTypeMethod; Normal+specific → OR'd.
  (byte-identical clause structure to the old METHOD_NONE logic, so the D/L/Normal
  numbers are unchanged.)
- drawerInnings.js: new shared `mountAllMultiSelect` ("All + specifics" picker: All
  leads & is disabled-while-checked; picking a specific unchecks All; unchecking the
  last specific snaps back to All). mountResult rewritten to host the Result picker +
  a NESTED Result Type sub-picker (`.result-type`), shown whenever the Result condition
  is present (result.length>0) — mirrors the Event→Season nesting. mountMethod DELETED.
- drawer.js: mc_method singleton + MATCH_CONTEXT_ADD_ORDER entry + mountMethod call
  removed. Adding the Result condition seeds result=["all"] AND resultType=["all"]
  (both All auto-checked). Removing Result clears both. activeFilterCount reads
  resultTypeFilterActive (Result and Result Type count independently when narrowing).
- pills.js: Result pill lists only narrowing outcomes (drops All); removing it clears
  BOTH result+resultType. New independent "Result type: …" pill (removing it snaps
  resultType back to All, leaving the Result condition intact).
- table.js: serializeQueryState key `method` → `resultType` (cache/dirty key only).
- styles.css: `.filter-group--result` + `.result-type` / `.result-type__head` mirror
  `.filter-group--event` / `.event-seasons`.

## FIX C — Stage options scoped to all four dims
- playerData.js: new `searchStages(gender, teamType, formats, dateFrom, dateTo)` using
  the shared `matchOptionScope` (the SAME scope the Event/Venue pickers use). Returns
  raw event_stage spellings; mountStage folds to canonical as before.
- drawerInnings.js mountStage: was gender-only (cached by loadedGender) → now a full
  scopeKey (gender|teamType|formats|dateFrom|dateTo), reloads via searchStages when any
  of the four changes (loadToken guards races). Options-only; no aggregate touched.

## Verified (localhost:8000, local Wave-6 export; config override REVERTED to R2)
- BYTE-IDENTICAL harness (node, real buildQuery+buildMatchupQuery+graph-fetch SQL, HEAD
  1143403 vs working tree): (a) no match-context condition and (b) Result condition added
  with Result=All + Result Type=All → BOTH identical to HEAD. Identical sha256 across all
  three (1b279618c523…). Positive control: Result=Won → `batting_team = mctx.match_winner`;
  ResultType=Normal → `mctx.method IS NULL`; D/L → `IN ('D/L')`; Normal+D/L → OR'd;
  All+All → active=false, no clause.
- Anchors reproduced in-app via the REAL buildQuery (Men/T20/International 2023-07-01→
  2026-07-02): 2,813 players / Karanbir Singh 2,454 / SA Yadav 60 inns·1,544 runs·29.13
  avg·150.34 SR.
- Independent DuckDB cross-checks (hand-written SQL vs data/export parquets, NOT the app's
  aggregation) — and the app's real buildQuery reproduces each exactly:
  Result Type = Normal → SA Yadav 58 inns / 1,462 runs; Result Type = D/L → 2 / 82;
  Result = Won + Result Type = All → 48 / 1,277. Live UI (D/L filter applied): SA Yadav
  row Inns=2 / Runs=82; pill "Result type: D/L (Rain)".
- FIX C: T20 international scope lists Qualifier/etc.; RED-BALL (Test) international scope
  lists ONLY "Final" — 0 T20-only rounds leak in (via the real searchStages).
- UI: adding Result auto-checks "All results" (disabled-while-checked) + shows the nested
  Result Type sub-picker with "All result types" auto-checked; picking Won unchecks All;
  unchecking Won snaps back to All; Result Type options exactly All/Normal/D/L (Rain)/
  VJD (Rain)/Awarded/Fewer Wickets. 0 console errors throughout boot + interactions.

## Concerns (flagged, not resolved)
- Stage-clearing consistency (FIX C): stage OPTIONS now depend on all four scope dims,
  but state.stage is only CLEARED on gender/format changes (FIX 2, filters.js), NOT on
  date/team-type changes — whereas event/venue/opposition are cleared on all four. So a
  date or team-type change reloads the Stage list for the new scope but can leave a stale
  state.stage selection applied-but-not-shown (the season picker handles the analogous
  case with reconcileNarrowing). I kept FIX C strictly options-only per the brief and did
  NOT add date/team-type stage-clearing (that would be a behaviour change beyond the
  stated scope). Owner/orchestrator to decide whether stage should clear on all four
  scope changes for full consistency.
- "Awarded" / "Lost fewer wickets" (5 matches total, non-rain) are grouped under Result
  Type per the brief's explicit option list — carried over from the prior FIX 3 grouping.
