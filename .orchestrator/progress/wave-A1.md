# Wave A1 — display-only polish (item 1 + item 4)

## Item 1 — "Vs" -> "Matchup (Vs)", moved to top of "+ Add condition"
Status: DONE, committed (978e30a).

- `src/drawer.js` `SINGLETON_TYPES`: the `vs` entry's label is now
  `"Matchup (Vs)"`; moved to the front of the array (this also reorders its
  applied-row render position — expected/documented in the brief).
- `basicOpts()`: removed the old `vsOpt` injection right after "Innings".
- `addSelectOptionsHTML()`: added a standalone `vsTopOpt` `<option>` rendered
  ABOVE the Player/Match/Basic/Advanced/Dismissal optgroups — i.e. literally
  the first selectable entry in the whole dropdown, in both Stats (main.js)
  and Graph (graph/graph.js) since both mount the same `mountFilterDrawer`.
- Left `src/table.js:1245`'s hardcoded toolbar `<span class="table-toolbar__vs-label">Vs</span>`
  untouched, per instruction — flagged in the report for the owner to decide.

Gotcha: none. `singletonOpt("vs")` already handled the women/menOnly + disabled
cases, so the new top-level option reused it verbatim — no new logic needed.

## Item 4 — format-aware "(Innings)" suffix on Best Bowling
Status: DONE, committed (88b0069).

- `src/metrics.js`: new helper `metricDisplayLabel(metric, formats)` — strips
  a trailing `" (Innings)"` from a label unless `formats` includes `"Red Ball"`
  (mixed scopes keep the suffix, per the brief). Purely additive; no existing
  metric object touched (verified via `git diff` grep for
  sqlExpression/sortExpression/buildQuery/buildMatchupQuery — empty except my
  own doc-comment prose).
- Wired at every render site found: `drawer.js` `metricLabel()` (the
  already-added condition row's label) and `metricOpt()` (the "+ Add
  condition" dropdown option itself, for the `basic` and `advanced` groups —
  "best" is in `BASIC_METRIC_KEYS` so it flows through `metricOpt` in
  `basicOpts()`); `pills.js` `metricLabelFor()` (the removable condition
  pill); `table.js`'s Columns popover checkbox list (`openColumnsPopover`'s
  `section()` closure).
- `groupCardHTML`/`conditionRowHTML` now thread `s.formats` through so the
  row label can resolve correctly.

Gotcha / concern carried to the report: `state.js`'s `conditionScopeLabel`
(~line 239-246, feeding `describeScope()` -> Graph card footers via
`src/graph/card.js`) is a hand-duplicated twin of the exact logic I fixed in
pills.js — its own comment says "keep the two phrasings in sync by hand". I
did NOT touch it: `state.js` is READ-ONLY per the brief and `src/graph/*` is
in the MUST NOT TOUCH list. So Graph card footers will still show
"Best Bowling (Innings) ≥ X" in a T20-only scope even after this fix. Flagged
under CONCERNS, not fixed — needs an explicit follow-up task or owner call.

## Verification run
- `node --check` on all 4 touched files: PASS.
- `git diff -- src/table.js src/metrics.js | grep -iE "sqlExpression|sortExpression|peakInner|peakOuter|buildQuery|buildMatchupQuery"` —
  only matches are inside my own new doc-comment (the words appear as prose
  saying they're untouched), no actual field/query line changed.
- No browser driven (per brief — orchestrator owns that verification pass).
