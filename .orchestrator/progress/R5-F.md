# R5-F progress

## Done
- #14 club/domestic opposition enabled (decision 51). state.js oppositionFilterActive
  one-line gate change + comments; drawerInnings.js mountOpposition ungreyed + comments.
  Verified: International anchors unchanged; Domestic+vs Punjab Kings -> 152 players in
  app, matches independent hand-written DuckDB COUNT(DISTINCT batter_id). Commit e672ec7.

- #16 player-popup Filters drawer restyled to main-drawer density (playerFilters.js,
  styles.css): narrower panel (380px->320px), Date window collapsed to one row
  (From - To, was 3 stacked lines), Batting position + Vs paired in a 2-column grid
  row (they already show/hide together), compact control sizing reusing the main
  popup's own tokens (34px min-height, --text-sm2, --space-* gaps). Consolidated
  els.posSection/els.vsSection into one els.battingRow hide toggle (same behavior).
  Verified in-browser: SA Yadav popup, Batting position dropdown + Vs + Apply all
  work (Batting at 4 -> 34 inns/967 runs/32.23 avg/150.39 SR, matches the position
  table); Bowling tab hides the row with no empty gap; checked at 380px mobile too.
  Caught + fixed a self-introduced syntax error (backticks inside an HTML comment
  broke the outer JS template literal) before it was verified — see CONCERNS in
  the final report.

## Next
- Both R5-F items complete and verified. Awaiting owner review.

## Gotchas
- Browser-automation coordinate clicks land on WRONG elements (portal dropdowns render
  at real DOM positions that don't match the screenshot's apparent pixel grid — a raw
  coordinate click that looks right in the screenshot can hit the modal backdrop and
  close the whole Filters drawer). Always click by `ref` (from read_page), not by
  eyeballed screenshot coordinate. For the searchSelect option rows specifically (team/
  opposition/event/venue pickers), use the documented workaround: dispatch a synthetic
  `click` MouseEvent directly on the `.search-select__option` DOM element via
  javascript_tool — per DESIGN_ROUND5_HANDOFF.md's "HOW TO VERIFY" note, this control
  resists both coordinate clicks and ref-based synthetic clicks under automation.
