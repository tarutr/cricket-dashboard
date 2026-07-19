# Wave R5-A — interaction rules & regressions (progress)

Branch: polish-b1-mechanical. Display/state only — aggregation SQL byte-identical by construction.

## Anchors / guards (must hold)
- 2,813 players; Karanbir 2,454; SA Yadav 60/1544/29.13/150.34; SA Yadav vs Spin 38/454/140.99;
  Bumrah vs RHB pos1,2 27/177/9.
- Plain fingerprint (standard all-filters plain state) = djb2 3307620867 / len 1430.
  Recipe: Men/T20/Intl 2023-07-01→2026-07-02, batting, cols [innings,runs,strike_rate],
  teams+opp+event+venue+profileHand+rpos+pin (NO stat condition).

## Items
- #1 remove ALL toolbar note text — DONE (commit 537494a; verified no note plain/matchup)
- #5 Matchup(Vs) = first entry INSIDE Advanced group — DONE (commit 6d869bb; verified above Dot Ball %)
- #8 split striker Batting position out of R.Pos — DONE (commit 6d869bb; verified no auto-show, own row)
- #10 grey Keep-Columns on discipline-switch/blank — DONE (commit fd24d5a; verified 3 states)
- #15 force searchSelect summary/options resync — DONE (commit b320207; India→All teams no-click)
- housekeeping (a) delete minSampleComponent metadata — DONE (114 lines; no consumer; node --check OK)
- housekeeping (b) MIN_BALLS_PER_YEAR — **NOT REMOVED / FLAGGED**: its only consumer is the fading
  guard in src/graph/timeseriesChart.js (lines 13/113/185), a MUST-NOT-TOUCH file owned by R5-D.
  Minimal deletion impossible without editing forbidden file; R5-D (Line redesign) explicitly deletes
  it. Followed the brief's STOP-and-flag instruction. Leaving for R5-D.
- #7 conditions per-discipline — DONE (commit af835b9). DIVERGED from literal shape:
  used state.advanced (current disc, unchanged shape) + state.advancedByDiscipline archive,
  swapped in createStore.set — because graph.js (must-not-touch) reads state.advanced.groups.
  Verified: fingerprints byte-identical (all 4), round-trip batting/bowling, hand-filter persists.
- #9 filters popup fully staged — DONE (commit 4740b27). Verified: popup condition add → no pill/
  no table change until Search; popup Search → pill+table; filter pill × soft-deletes (red +, pending);
  pin add via results search instant (pill, Search not lit).
- #4 no reorder on toolbar-only commit — DONE (commit 1d32da3). Verified: Vs via TOOLBAR Search
  preserves order (Karanbir stays top); Vs via POPUP Search re-sorts (Waseem 701>688>677 desc);
  header click re-sorts.

## FINAL SWEEP (all items, clean reload, 0 console errors)
- node --check all 7 touched .js: OK. filters.js/advanced.js/graph/* UNTOUCHED (git diff).
- Fingerprints byte-identical: anchor 482/2375464873, plain 1422/3402920314, cond 572/1532651395,
  mcond 2969/4063295881.
- On screen: 2,813 players; Karanbir 2,454; SA Yadav 60/1544/29.13/150.34.
- Bumrah bowling matchup Vs=RHB striker pos 1,2 (via new strikerpos control) = 27/177/9.
- Graphs tab renders, 0 console errors (graph.js metricConditionKeys reads state.advanced.groups = current disc — works).
- ALL R5-A items complete except housekeeping(b) MIN_BALLS_PER_YEAR (flagged, not built).

## Baselines captured BEFORE changes (2026-07-19, localhost:8000, R2)
- anchor query (default batting, anchor scope, 8 cols): len 482 / djb2 2375464873
- plain all-filters (my repro; cols innings,runs,strike_rate + teams India/opp Australia/
  event IPL/venue Eden Gardens/profileHand RHB/rpos [3]/pin abc123): len 1422 / 3402920314
- plain w/ conditions (runs>=300 + SR between 120-160; cols innings,runs,average,strike_rate):
  len 572 / 1532651395
- matchup w/ conditions (Vs=Spin batting, high_score>=40, default matchup_batting cols):
  len 2969 / 4063295881
- Anchors on app SQL: 2813 players; Karanbir 2454; SA Yadav 60/1544/29.13/150.34.
- Independent DISTINCT(batter_id,batter_name) pairs = 2813 (matches app).
- NOTE: could NOT reproduce the brief's magic 3307620867/1430 — that recipe's exact filter
  STRING values aren't recorded, so length differs (1422). Using captured before/after
  invariants on these states as the byte-identity guard instead (stronger: covers cond path).

## Notes / gotchas
- styles.css is at REPO ROOT (brief said src/styles.css). timeseries.js is src/graph/timeseries.js.
- keepColumns checkbox: index.html data-role fpop-keep-columns, label .fpop-keep-columns.
