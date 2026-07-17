# Wave: Coverage breakdown columns

Branch `polish-b1-mechanical`, builds on Wave 4b (HEAD c4e59af).

## Goal
Replace the single matchup "Coverage — N of M (X%)" column with a per-group
percentage breakdown (composition), and mirror it into the profile popup's
COARSE matchup tables only.

- Part A (Stats table Vs mode): 3 ordinary columns.
  - Batting: Pace BF % / Spin BF % / Uncategorised BF % (of TOTAL balls faced).
  - Bowling: RHB % / LHB % / Uncategorised % (of TOTAL balls bowled).
  - Ordinary columns: sortable, draggable, toggleable; default far-right + ON.
  - Remove old fixed Coverage column. Table-only (not graph vocab). higherIsBetter null.
  - 0% is VALID data (zeroIsData true), never hidden.
- Part B (popup): right-most % column on COARSE tables only; keep coverage text
  line; DO NOT change fine "Vs bowling type" table.

## Independent DuckDB baselines (from R2, server-side, before any change)
Scope: gender male, match_type IN (T20,IT20), international, 2023-07-01 → <2026-07-03.
- SA Yadav (271f83cd) balls_faced: Pace 591, Spin 322, (unmapped) 114, total 1027
  → 57.5 / 31.4 / 11.1  (sum 100.0)
- SA Yadav vs Spin per-bucket: 38 inns / 454 runs / 140.99 SR  (ANCHOR)
- Bumrah (462411b3) balls: RHB 464, LHB 185, (unmapped) 58, total 707
  → 65.6 / 26.2 / 8.2  (sum 100.0)
- Bumrah vs RHB pos 1,2 per-bucket: 27 inns / 177 balls / 9 wkts  (ANCHOR)

## Plan
- metrics.js: +6 composition metrics (kind "composition", compositionGroup, placeholder sqlExpression).
- state.js: append comp_* to DEFAULT_MATCHUP_COLUMNS (far-right).
- table.js: buildMatchupQuery computes composition via unfiltered partial→window→%-of-__coverage_total;
  remove fixed Coverage th/td + coverageLabel + row.coverage mapping; conditionToHaving guard.
- advanced.js: exclude composition metrics from stat-condition picker.
- playerData.js: exclude composition keys from MATCHUP_*_KEYS (placeholder SQL must not reach queries).
- playerSections.js: add % column to coarse batting + bowling-hands tables (Part B).
- styles.css: remove orphaned .data-table__th/td--coverage rules.

## Verified (headless, against R2 via DuckDB CLI + Node buildQuery harness)
- Plain fingerprint = 3307620867 / len 1430 — UNCHANGED (plain path byte-identical).
- SA Yadav vs Spin (batting matchup, generated query) = 38 / 454 / 140.99 — UNCHANGED anchor.
- SA Yadav composition = comp_pace 57.55 / comp_spin 31.35 / comp_uncat 11.10 (sum 100), cov 913/1027.
- Bumrah vs RHB @ positions 1,2 (generated query) = 27 / 177 / 9 — UNCHANGED anchor;
  composition correctly recomputes over the pos-filtered scope (72.5/20.9/6.6, sum 100).
- Bumrah composition (base scope) = 65.6 / 26.2 / 8.2 (sum 100), cov 649/707.
- Independent baselines (hand-written COUNT DISTINCT / SUM CASE GROUP BY) matched the
  app-generated SQL exactly — decision-39 rule satisfied.
- node --check: all 6 touched files OK.

## Browser-verified (localhost:8000, modules cache-reloaded + page reloaded, ZERO console errors)
- In-browser independent DuckDB (hand-written shapes): SA Yadav comp balls 591/322/114 →
  57.5/31.4/11.1; vs Spin 38/454/140.99; Bumrah vs RHB pos1,2 27/177/9. All match.
- In-browser buildQuery plain fingerprint = 3307620867 / 1430 (unchanged).
- Vs mode UI: 3 composition columns render FAR-RIGHT, default ON; old Coverage column GONE.
  - Sortable: clicking "Spin BF %" re-sorts instantly (header ▼), Search stays disabled.
  - 0.0% RENDERS (not "—") — zeroIsData works; rows sum to 100 (0.0+100.0+0.0).
  - Draggable: all 3 carry data-table__th--draggable + data-key.
  - Toggleable: appear in Columns picker (Basic, checked); toggling comp_uncat OFF removes
    only that column instantly, Search stays disabled; re-toggle restores.
- Popup batting (SA Yadav, scope T20 both 2020→2026): coverage text retained; coarse
  "Vs pace and spin" gains "% BF" (Pace 52.8% = 2095/3968, Spin 37.0% = 1467/3968 — matches
  independent DuckDB for that scope); fine "Vs bowling type" UNCHANGED (no % column).
- Popup bowling (Bumrah): coverage text retained; hands table gains "% balls"
  (RHB 62.2% = 1831/2946, LHB 29.2% = 860/2946).
- Graph exclusion: structural — graph nulls matchupVs, uses eligibleMetrics(plain discipline),
  which never includes matchup_* metrics. Composition metrics are table-only by construction.

## Status
- [x] implement / [x] node --check / [x] headless verify / [x] browser verify / [x] committed 0af4d58

---

## Follow-up refinements (3 owner-requested changes) — 2026-07-17

### What changed
- metrics.js: comp_uncat `shortLabel` "Uncategorised BF %"/"Uncategorised %" -> "Uncat %"
  (both disciplines); full `label` kept for the Columns picker. No sqlExpression/kind touched.
- playerData.js: popup coarse batting query + bowling-hands query now INCLUDE the
  '(unmapped)' bucket (dropped the `<> '(unmapped)'` clause). Fine "Vs bowling type" query
  still drops it. Doc comments updated.
- playerSections.js: render '(unmapped)' as an "Uncategorised" row — COARSE_LABEL map (batting,
  ordered last via COARSE_ORDER `?? 2`) and HAND_LABELS['(unmapped)'] + a stable sort that
  forces '(unmapped)' last (bowling). Coverage lines "Style data"/"Batting-hand data" -> "Matchup data".

### Verified (localhost:8000, modules cache-reloaded + page reloaded, ZERO console errors)
- Plain fingerprint (Node buildQuery harness) = 3307620867 / 1430 — UNCHANGED.
- Anchors (independent hand-written DuckDB): SA Yadav vs Spin 38/454/140.99; Bumrah vs RHB
  pos1,2 27/177/9. Plain baseline on screen: 2,813 players, Karanbir Singh 2,454; SA Yadav 60/1,544/29.13/150.34.
- Change 1: Vs table header reads "Uncat %" both disciplines; Pace/Spin/RHB/LHB headers unchanged;
  Columns picker shows full "Uncategorised BF %"; composition sums to 100% (SA Yadav 57.5/31.4/11.1).
- Change 2 batting (SA Yadav popup, T20 both 2020->2026-07-13): coarse "Vs pace and spin" =
  Pace 52.8% / Spin 37.0% / Uncategorised 10.2% (sum 100). Uncat row 54/406/669/164.78/51.46/13
  MATCHES independent DuckDB over bowling_group='(unmapped)' exactly. Fine "Vs bowling type" has
  NO % column (unchanged).
- Change 2 bowling (Bumrah popup, same scope): "Vs L/R-handers" = RHB 62.2% / LHB 29.2% /
  Uncategorised 8.7% (sum 100). Uncat row 44/255/310/18/7.29/17.22/14.17 MATCHES independent
  DuckDB over batting_hand='(unmapped)' exactly. Uncategorised rendered LAST.
- Change 3: batting "Matchup data covers 3,562 of 3,968 balls faced (89.8%)."; bowling
  "Matchup data covers 2,691 of 2,946 balls bowled (91.3%)."
- node --check: metrics.js, playerData.js, playerSections.js all OK.

### Concern (not changed — out of task scope)
- playerSections.js battingGridHTML (~line 538) has a SECOND "Style data covers …" coverage line,
  used only for the drawer-Vs-scoped hero tiles (shown when the popup's own Filters drawer sets a
  Vs bucket; in that mode the Matchups section is greyed, so the two lines never appear together).
  Task Change 3 named "the batting line ... and the bowling line" (2 lines, "above those tables"),
  so I left this third instance as "Style data". Flag for owner if they want it consistent too.
