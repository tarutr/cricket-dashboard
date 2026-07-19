# Wave R5-B — the pin system + sort-arrow honesty (progress)

Branch: polish-b1-mechanical. Display/state only — buildQuery/buildMatchupQuery SQL byte-identical.
filters.js MUST NOT be edited (uses whereWithPinExemption/gateWithPinExemption).

## Anchors / guards (must hold)
- 2,813 players; Karanbir 2,454; SA Yadav 60/1544/29.13/150.34; SA Yadav vs Spin 38/454/140.99;
  Bumrah vs RHB pos1,2 27/177/9.
- buildQuery output length UNCHANGED for standard plain state (capture before/after).

## Design decisions
- #0 arrow: closure-level `orderIsActiveSort` in mountTable. Set true when load() applySort (fresh/popup
  Search) or applySortKey (header click); false on toolbar-only preserve. Pin toggle preserves the flag
  (preserveSortFlag option). headerCellHTML + name header show arrow only when orderIsActiveSort && sort.key match.
- Float: lastRows stays the BASE ordered array (NOT floated). float applied at RENDER time
  (floatPinsToTop) — so unpin returns a player to their true ranked slot. Rank cell = true position in
  base order (pinned rows keep their real rank; no-data synthetic pins show "—").
- No-data pin: synthetic {id,name} row injected at render (formatValue → "—" for undefined). Row count
  label stays the real query count (excludes synthetic).
- Pin column: sticky, left of #. --pin-col-w fallback 2.5rem. Toggle is INSTANT both ways (pin via
  existing pinPlayer, unpin via new unpinPlayer). FLAG: pill ×/+ stays pending (decision 47g) —
  pin-column is instant; owner may want them unified.
- #2 search-add already pins (pinPlayer) → floats via #3. applyPinnedPlayers now load(resort:false,
  preserveSortFlag:true) so a pin never reshuffles non-pinned rows or flips the arrow.
- #3 reset/persist: popup Search (runSearch !fromToolbar) clears pins; toolbar Search keeps them.
- #6 auto-add: on popup Search, add each complete-condition metric's column if missing (ns-aware), rank
  by first auto-added. Always runs regardless of keepColumns — FLAG. Multi-condition: rank by first — FLAG.

## Items
- baseline repro: DONE (2,813 / Karanbir 2,454 / SA Yadav 60·1544·29.13·150.34; 0 errors)
  buildQuery fingerprints: plain 482/2182256011, matchup(Spin) 2500/3064880972 (before-change)
- #0 arrow honesty: DONE (commit c6fb042). Verified fresh→▼, toolbar Vs Search→no arrow, header click→▼+resort.
- #3/#2/#11/#12 pin system: DONE. Verified in browser:
  - pin mid-table (SA Yadav rank11) → floats top, active pin, true rank 11 kept, non-pinned unchanged, arrow kept.
  - unpin → returns to rank 11.
  - persist: pin + toolbar Vs→Spin + toolbar Search → pin stays (arrow cleared, correct #0).
  - reset: popup Search → pins cleared, no pin pills, arrow restored.
  - #11: bowling + Vs=LHB, pin SA Yadav via results search → row shows REAL 1/4/1/4/6.00/4.00/4.00
    (matches DuckDB 1inns/4balls/1wkt/4runs); search NOT lit. Composition RHB33.3/LHB66.7.
  - "–": pin P Nissanka (pure batsman, 0 bowling rows) → all "—" cells + rank "—", pill "(no innings)",
    count unchanged 1,660.
  - buildQuery byte-identical after wave (same 482/2182256011, 2500/3064880972). filters.js 0 diff.
- #6 auto-add filtered column: DONE (code landed in 518ce86 with the main.js changes; verified here).
  Repro: bowling, remove Best Bowling via Columns, add condition "Best Bowling ≥3W for ≤20R", popup Search
  → BBI column re-appears + table sorts by it (BBI ▼, 8-7, 7-7, 7-8, 7-19, 6-2, 6-3, 6-7, 6-8), 680 players.
  Removable: Columns picker shows BBI checked; unchecking removes it.
  INDEPENDENT DuckDB (ROW_NUMBER window, NOT the app's arg_max/MAX):
    - top-8 by best figure = identical ids/names/BBI + order to the app.
    - condition count: best-rank >= 3000-20 = 2980 → 680 (by-id AND by-id-name), matches app exactly.
      (My first naive qual `wkts>=3 AND runs<=20` gave 599 — wrong reading of the two-box condition,
      which is a rank threshold that also admits any 4+ wkt innings; the app's 680 is correct.)

## FINAL VERIFICATION (post-wave, clean reload, 0 console errors)
- buildQuery byte-identical: plain 482/2182256011, matchup(Spin) 2500/3064880972 — SAME as pre-wave.
- Anchors on screen + DuckDB: 2,813 / Karanbir 2,454 / SA Yadav 60·1544·29.13·150.34; SA Yadav vs Spin
  38·454·140.99 (DuckDB).
- filters.js / drawer.js / advanced.js / metrics.js / graph/* = 0 diff across the whole wave.
- Commits: c6fb042 (#0) · 518ce86 (#3/#2/#11/#12 + #6 code).

## SCOPE FLAGS (for owner)
- Pin-column toggle is INSTANT both ways (pin + unpin); the pin PILL's ×/+ stays a pending soft-delete
  (decision 47g, untouched). Owner may want them unified.
- Rank cell = TRUE base-order rank: a floated pin keeps its real leaderboard rank (e.g. SA Yadav "1,329");
  a no-data pin shows "—". Chosen as the most honest; flag for confirmation.
- Row-count label counts real query rows only (a no-data synthetic pin does NOT inflate "N players").
- #6 auto-add runs on EVERY popup Search regardless of "Keep Selected Columns" (Keep-Columns governs the
  default-resync on discipline/format change, a separate concern). Multi-condition: rank by the FIRST
  filtered metric; all missing filtered columns are added.
- Reset trigger is the POPUP Search button specifically; a toolbar Search keeps pins (matches brief).

## Gotchas
- styles.css is at REPO ROOT.
- query() returns {rows, ms}; SUM → BigInt → Number(). batting id col = batter_id.
