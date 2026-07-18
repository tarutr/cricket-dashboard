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

## ORCHESTRATOR follow-up + verification (2026-07-18, commit 2bc377b)
- CONCERN #2 (conditionScopeLabel twin) CONFIRMED REAL and FIXED inline by the
  orchestrator: state.js:243 now routes through metricDisplayLabel(metric,
  state.formats) (import added line 26). metrics.js does not import state.js →
  no cycle; state.formats is in scope in describeScope. node --check state.js PASS;
  git diff shows no query/scope-logic (buildScopeClauses/expandFormats/FORMAT_BUCKETS)
  touched. This completes item 4 across the Stats subtitle + Graph card footer.
- CONCERN #1 (toolbar hardcoded "Vs" at table.js:1245) left as-is — a FLAG for the
  owner at the Wave A gate (rename toolbar to match, or leave). Not built.
- IN-BROWSER verification (orchestrator, localhost:8000, modules cache-reloaded):
  * Item 1: "Matchup (Vs)" is the FIRST "+ Add condition" entry in BOTH the Stats
    drawer AND the Graph drawer (shared mountFilterDrawer). Old "Vs"-after-Innings gone.
  * Item 4: metricDisplayLabel unit-checked on the real plain + matchup `best` metrics —
    T20 / 50 Over / empty => "Best Bowling"; Red Ball / mixed(Red Ball+T20) =>
    "Best Bowling (Innings)". LIVE: bowling condition dropdown reads "Best Bowling"
    under T20-only, "Best Bowling (Innings)" after ticking Red Ball.
  * Scope-sentence (state.js) live confirmation DEFERRED to the A2 gate — it needs a
    WORKING Best Bowling condition (item 2) to appear in the subtitle; the wiring is
    diff-confirmed + the helper is proven.
  * ANCHOR GUARD: 2,813 baseline re-run on screen AFTER A1 — Karanbir 2,454 top,
    SA Yadav 64/60/1,544/29.13/150.34. Byte-identical. Zero console errors.
- A1 VERIFIED. Proceeding to A2 (items 2+3).
