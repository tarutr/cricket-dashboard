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
- baseline repro: TODO
- #0 arrow honesty: TODO
- #3 pin column + float + reset/persist + "–": TODO
- #2 search-add float: TODO
- #11 in-scope data (SA Yadav bowling vs LHB): TODO
- #12 marking: TODO (pin column)
- #6 auto-add filtered column: TODO

## Gotchas
- styles.css is at REPO ROOT.
- query() returns {rows, ms}; SUM → BigInt → Number(). batting id col = batter_id.
