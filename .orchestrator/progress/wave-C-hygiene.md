# Wave C — 4f-D hygiene (dead CSS removal)

Solo Sonnet worker, styles.css only, no .js/.html touched. Commit d590583.

## Classes removed (grep-proven zero references in src/*.js + index.html before deletion)
- `.table-prompt`, `.table-prompt__text`
- `.table-toolbar__actions` (two separate rule definitions, both dead)
- `.table-toolbar__presets`, `.chip--preset`
- `.graph-benchmark-metrics__panel`, `.graph-benchmark-metrics__group-label`
  (+ `:first-child` variant)
- `.graph-radar-metrics__panel`, `.graph-radar-metrics__group-label`,
  `.graph-radar-metrics__note`
- `.table-toolbar__controls`
- `.table-toolbar__graph-columns`
- `.table-toolbar__group-label`
- `.select--compact` (+ its `@media (max-width: 480px)` override)
- `.table-toolbar__matchup-note`

`.table-toolbar__dynamic` (also on the candidate list) had NO CSS rule at all —
only mentioned in two prose comments (styles.css ~1013/1017) documenting that
it no longer exists. Nothing to remove there; left the comments as-is (out of
scope to rewrite comments for a class that was never a live rule here).

## Kept (still referenced — did not touch)
- `.table-toolbar__clear-btn` — used in `src/table.js:1301`
  (`class="btn btn--ghost table-toolbar__clear-btn"`). NOT on the dead list
  and confirmed live; untouched.
- `.fpop-keep-columns`, `.pill--no-innings`, `.search-select*` — per brief,
  confirmed still present/in use, not touched.

## Also fixed (small, in-scope)
- One doc comment above `.table-toolbar__clear-btn` (the "Leaderboard matchup
  mode" section header) referenced `.table-toolbar__controls` by name in its
  last sentence; since that class was just deleted, the sentence was stale.
  Trimmed the dangling clause, kept the rest of the comment (still accurate
  context for the surviving `.table-toolbar__clear-btn` rules below it).

## Verification
- Brace count balanced (580 open / 580 close) before and after.
- Re-grepped the full repo (src/, index.html, styles.css) for all 11 removed
  class names post-edit: zero hits anywhere.
- `git diff --stat`: only `styles.css` changed, 1 insertion / 156 deletions
  (net -155 lines; file 4,516 -> 4,361 lines).
- No `.js`/`.html` file touched (git status confirms styles.css only).
- Did not drive a browser (per brief) — orchestrator to confirm no visual
  regression across Stats table, Filters drawer, Graphs, player popup.
