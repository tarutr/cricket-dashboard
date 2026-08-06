# Tab-2 T-3b — Fielding-mode UI (on the T-3a-ext query) — progress

Branch `ball-layer`, main working tree. NO git (orchestrator commits). Numbers sacred (Rule 1):
touch NO query builders (buildQuery/buildMatchupQuery/buildFieldingCteSql/
buildFieldingSliceClauses/buildFieldingExtraSliceClauses/buildFieldingRowQuery). UI only.

## Approach (stated for the record; key risk)
- **Discipline control**: the Filters tab gets its OWN segmented control Batting|Bowling|Fielding
  in its toolbar; it fully OWNS the tab discipline. The pop-up HEADER toggle stays Batting|Bowling
  (drives Overview only) and is HIDDEN while the Filters tab is active (so exactly one discipline
  control shows, no duplication; Overview never offers Fielding — owner ruling). playerPage stops
  pushing discipline into the tab; `show(id, disc|null, state)` treats null as "keep current".
  KEY RISK / owner-flag: this decouples the header toggle from the tab and hides it on Filters — a
  UX/mechanism choice within the brief's "implement cleanly." Flagged in report.
- **Fielding editor** = NEW `src/playerFieldingEditor.js` (the batting/bowling slice editor is
  deeply wired for per-innings slices/matchup; a fielding branch there would risk the verified
  path). Reuses: the modal shell/.pfe- styles; the scope-singleton controller (playerFilterScope.js)
  for Team/Opposition/Event/Venue (the ONLY singletons buildFieldingCteSql honors top-level);
  createAddPalette; the omnisearch player picker for specific batter/bowler; a shared checklist
  widget (batting-position style) for every categorical dim.
- **Dim routing** (from T-3a-ext): Team/Opposition/Event/Venue → row.singletons (top-level, honored
  by buildFieldingCteSql's buildScopeClausesTagged). Everything else → row.fielding.*:
  kinds/positions/phases/hands/roles/outBatters/bowlers/bowlerStyles/cities/inningsNumbers(0-based
  STORED)/overFrom-overTo(0-based STORED)/seasons/stage/result/tossResult/tossDecision. Match-context
  (stage/result/toss) is NOT a scope singleton for fielding — it rides state.fielding via the mctx
  EXISTS — so it uses my checklist, NOT the reused mountResult (which also exposes resultCondition,
  which fielding IGNORES → would be a dishonest filter). Innings Number is likewise fielding.* (the
  top-level inn_num is inert for fielding_team), stored 0-based.
- **DATA-DRIVEN gating (NO gender hardcode)**: Hand/Role/BowlerStyle/City/Season/Stage load options
  via loadDimOptions(source,col,scope) on open; a dim is offered ONLY if its option list is non-empty.
  Men → all appear; women → Hand/Role/BowlerStyle vanish (all NULL). ZERO if(!women) in gating.
- **Columns**: fixed fielding tally set (Catches · Stumpings · Run-outs · Caught & bowled ·
  Dismissals Effected · Matches) — no picker/preset in fielding mode.

## Files
- src/playerFieldingEditor.js (NEW)
- src/playerFiltersTab.js — fielding discipline control + setDiscipline; fixed fielding columns +
  metric objects (getMetric has no "fielding" discipline); fielding editor wiring; fielding row labels.
- src/playerPage.js — decouple header toggle from tab; hide header toggle on Filters tab.
- styles.css — fielding editor + discipline control styles.

## Status: COMPLETE + VERIFIED (flag-off vs R2, browser + independent DuckDB)
- node --check OK on all 3 JS + new file. config.js NOT modified (git-clean). Sacred query files
  (table.js/filters.js/metrics.js/db.js/playerFilterEditor.js/paletteGroups.js) NOT modified.
- Leaderboard batting anchor byte-identical: 2,813 players / Karanbir Singh 2,454 (buildQuery).
- SA Yadav (untouched builders, the batting/bowling tab path): batting 60/1,544/29.13/150.34;
  Vs Spin 38/454/SR 140.99.
- Fielding via the tab's fetchFieldingRow == T-3a-ext + fresh independent raw counts (JC Buttler
  Men/T20/Intl 2023-07-01..2026-07-02): baseline 33/10/11/54 mt33; spin 7/10/1/18 mt15; result_won
  26/6/4/36 mt24; innings 2nd 15/2/0 mt11; tossdec bat 7/6/4 mt9; caught+spin 7 mt7.
- UI end-to-end (JC Buttler, pop-up scope T20/both/2020→2026-08-04): "Wicket type: Caught" row =
  CT 191 / ST 0 / RO 0 / C&B 0 / DIS EFF 191 / MAT 133 == independent raw count EXACT.
- DATA-DRIVEN gating ON SCREEN: men (JC Buttler) OFFERS Batting hand / Batter role / Bowler style;
  women (AJ Healy) HIDES all three (City/Season/Stage still shown). No gender hardcode (grep clean;
  loadDimOptions men hand2/role11/style16, women 0/0/0).
- Women's fielding row (AJ Healy) renders 54/43/24/121/77 == independent EXACT (query works flag-off
  for women too).
- Discipline control: Overview shows Batting|Bowling only (header toggle); Filters tab shows
  Batting|Bowling|Fielding (own control); header toggle HIDDEN on Filters, reappears on Overview.
  Switch Fielding→Batting reset rows + warned "Switching to Batting cleared your filter rows — a
  fielding filter can't slice batting."
- Fixed fielding columns CT · ST · RO · C&B · DIS EFF · MAT (owner order); no preset/columns picker
  in fielding mode. 0 console errors throughout.

## Open note for owner (flagged, not built)
- Discipline-control MECHANISM: the Filters tab now OWNS its discipline via its own control, and the
  pop-up header Batting|Bowling toggle is HIDDEN while the Filters tab is active (it drives Overview
  only, which can't show Fielding). One control on screen at a time; no duplication. If the owner
  prefers the header toggle to stay visible on the Filters tab, or the two to stay in sync for
  batting/bowling, that's a 1-line change — surface for a decision.
