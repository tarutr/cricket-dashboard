# R6 sort bugs — progress (branch polish-b1-mechanical)

Task: fix Stats-table sort bugs #1 and #3, confirm #6. Display/sort only — query builders
byte-identical, anchors hold. Owner is non-technical.

## Anchors (must hold; scope Men/T20/International, 2023-07-01→2026-07-02)
2,813 players / Karanbir 2,454 / SA Yadav 60·1,544·29.13·150.34 / SA Yadav vs Spin 38·454·140.99 /
Bumrah vs RHB striker pos 1,2 27·177·9.

## Bug #1 — fine-Vs re-sort — NOT REPRODUCIBLE (no code change)
Claim: picking a FINE Vs bowling type (Off-spin/Leg-spin/…) from the toolbar Vs dropdown re-sorts
the table, while COARSE (Pace/Spin) preserves order.

Reproduced 5 scenarios on localhost, current branch HEAD (served table.js confirmed = disk, has the
R5-A #4 + R5-B #0 fixes). EVERY toolbar Vs transition PRESERVES order and clears the sort arrow:
- plain → coarse Spin: preserved (RUNS vs Spin 488,701,677,544,567,688 — not descending), no arrow.
- coarse Spin → fine Off-spin: preserved (139,228,284,181,152,173), no arrow.
- plain → fine Off-spin directly: preserved, no arrow.
- fine Off-spin → fine Leg-spin: preserved (48,102,68,146,68,173), no arrow.
- active RUNS▼ column-sort, then toolbar fine Off-spin: order preserved, values swapped, arrow cleared.

The Filters-popup Search re-sorts for BOTH coarse AND fine (symmetric) — that is the ruled behaviour
(decision 50 #4: popup Search re-sorts; toolbar-only change preserves). So there is NO coarse/fine
asymmetry in either surface.

Root cause of the (non-existent) asymmetry the brief hypothesised: the resort decision is
`resort = !fromToolbar` in runSearch → load(null,{resort}), entirely independent of the matchupVs dim
(group vs type). Only 3 load() call-sites exist; none is triggered by a Vs change except runSearch.
`reorderPreservingPrevious` matches rows by String(id), identical for group/type. Confirmed in code + browser.

LIKELY EXPLANATION for the owner's report: the owner saw the POPUP Search re-sort (by-design) and
attributed it to "fine" because they set fine via the popup and coarse via the toolbar. Flagged for the
orchestrator to reconcile with the owner — I did NOT change sort logic (no repro; changing it risks anchors
and would reverse the ruled popup-Search-re-sorts behaviour, decision 50 #4).

## Bug #3 — Best-Bowling ranks by raw Wickets not BBI — FIXED
Root cause: `autoAddFilteredColumns` (main.js) set the sort ONLY when it ADDED a column
(`if (added.length === 0) return`). `best` (Best Bowling / BBI) ships in the DEFAULT bowling columns
(state.js DEFAULT_COLUMNS.bowling), so a Best-Bowling filter added no column, set no sort, and left the
table on its default sort (raw Wickets).

Fix: track the FIRST complete, rankable filtered metric (added OR already visible) and set the sort to it;
touch columns only when something was actually added. No-conditions case stays a no-op (anchor byte-identical).
main.js ONLY — no query/metrics/table.js change.

Verified (bowling, Best Bowling "≥3 wickets for ≤30 runs", popup Search):
- BEFORE: sort = WKTS▼; rows ranked by wickets (113,111,99,93…); BBI 7-19,6-9,4-5,4-5,4-17,4-18,5-51,5-35 (not BBI order).
- AFTER: sort = BBI▼; top rows 8-7, 7-7, 7-8, 7-19, 6-2, 6-3, 6-7, 6-8 (wickets desc, then runs asc).
- Independent per-innings DuckDB query (row-level, NOT the app's per-player aggregation):
  BBI leader S Yeshi 8-7 (rank 7993), then S Gill 7-7, Syazrul Idrus 7-8, Ali Dawood 7-19, N Master 6-2, H Bharadwaj 6-3
  → EXACT match to the app's top-6. App top row = true BBI leader.
- Anchor after fix: 2,813 / Karanbir 2,454 / 54.53 / 175.29; 0 console errors.

## Bug #6 — graph "Reset to full player set" — (verifying next)
