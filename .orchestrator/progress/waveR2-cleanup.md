# Wave R2 cleanup — mc_innings_order / fld_kind dead-plumbing teardown

Branch: `ball-layer`. Task: remove the now-inert plumbing for two filters the
filter-rejig replaced (waveR2c.md concern #3):
- `mc_innings_order` ("Innings order") → replaced by **Innings Number ▸**.
- `fld_kind` ("Dismissal kind" slice) → replaced by **Fielding Wicket Type ▸**
  (count operator).

## Inertness evidence (before touching anything)

Grepped `src/` for both keys, then specifically checked `buildPaletteGroups()`
in `src/drawer.js` (the function that actually drives what the "+ Add
condition" picker offers): neither key appears anywhere in it — only in a
`SINGLETON_TYPES` skeleton array (drives hidden row scaffolding + applied-row
order, not the palette) and in comments. Confirmed no `pickSingleton("fld_kind")`
or `pickSingleton("mc_innings_order")` call exists anywhere, so `isPresent()`
can only ever be true via a pre-existing state value — and nothing sets
`state.inningsOrder` or `state.fielding.kinds` any more. Both were genuinely
unreachable dead code with no live path in.

## What was removed, per file

- **src/drawer.js** — `SINGLETON_TYPES` entries for `fld_kind` / `mc_innings_order`;
  their `mountFieldingKind`/`mountInningsOrder` mounts + `.sync()` calls; the
  `fieldingKindActive`/`inningsOrderFilterActive` imports; `hasValue()` cases;
  `FIELDING_SLICE_KEYS` set entry; `clearSingleton()` cases; `activeCount()`
  disjuncts. Updated stale comments (buildPaletteGroups Match Details note,
  "Five categorical filters" → "Four", "fixed-vocabulary pickers" example).
- **src/drawerInnings.js** — `mountFieldingKind()` and `mountInningsOrder()`
  functions removed outright; `FIELDING_KIND_OPTIONS`/`INNINGS_ORDER_OPTIONS`
  imports dropped. Updated the "Five categorical filters" / "Three multi-select
  ... field is positions|kinds|phases" doc comments to match (Four / Two).
- **src/pills.js** — the `mc_innings_order` and `fld_kind` pill blocks removed;
  unused imports (`fieldingKindActive`, `inningsOrderFilterActive`,
  `FIELDING_KIND_OPTIONS`, `INNINGS_ORDER_OPTIONS`) dropped.
- **src/state.js** — `fieldingKindActive()`, `inningsOrderFilterActive()`
  removed; `FIELDING_KIND_OPTIONS`, `INNINGS_ORDER_OPTIONS` constants removed;
  `matchContextActive()`'s `inningsOrderFilterActive(state)` disjunct dropped
  (always false — behaviourally a no-op removal); default state's
  `fielding.kinds` and `inningsOrder` keys dropped; `describeScope()`'s
  innings-order token line removed. Left explanatory comments pointing at the
  replacement (Innings Number ▸ / Fielding Wicket Type ▸).
- **src/filters.js** — removed block 4 ("Innings order") from
  `buildMatchContextClauses`, the only clause actually owned by this file.
  Updated three stale comments elsewhere in the file that named "innings
  order" as a live example (kept one historical defect-account comment as-is
  — it correctly describes what existed at the time of that fix).
- **src/graph/graph.js** — removed `inningsOrder: buf.inningsOrder` from the
  "Apply to graph" commit list; removed `state.inningsOrder` from
  `scopeSeedKey()`'s cache-key array; updated the docstring listing which
  fields feed that key and the fielding-slice-fields comment (positions/kinds/
  phases → positions/phases).

## FLAG — brief vs. reality mismatch on fld_kind's SQL clause

The brief says "src/filters.js — the mc_innings_order clause in
buildMatchContextClauses, **and fld_kind's fielding scope clause**." The
mc_innings_order clause is indeed in filters.js (removed, block 4 above). But
**fld_kind's fielding scope clause is NOT in filters.js — it lives in
`src/table.js`'s `buildFieldingSliceClauses()`** (lines ~750–765), which feeds
`buildFieldingCteSql()`, documented there as "Extracted verbatim from
buildQuery." `table.js` is neither in my owned-files list nor safe to touch
per the explicit "Do NOT touch buildQuery/buildMatchupQuery" instruction, so
I left it untouched:

```js
// src/table.js:758-759 (untouched)
if (Array.isArray(f.kinds) && f.kinds.length > 0) {
  clauses.push(`kind IN (${f.kinds.map((k) => `'${esc(k)}'`).join(", ")})`);
}
```

This is confirmed harmless: `state.fielding.kinds` no longer exists on the
default state object (removed above) and nothing anywhere sets it any more,
so `f.kinds` is always `undefined` → `Array.isArray(undefined)` is `false` →
this branch can never fire, exactly as when it was always `[]` before. Same
file also still reads `state.inningsOrder` in `serializeQueryState()`
(table.js:121, a cache-key/Search-relight fingerprint) — also always
`undefined` now, `JSON.stringify` just omits it; since the term was constant
(always `[]`) before too, this changes nothing about when Search re-lights or
what buildQuery returns. Both are permanently-dead, harmless residue in an
off-limits file. Flagging per instructions rather than silently deviating —
if a full teardown of table.js's dead branches is wanted, that is a separate,
explicitly-scoped task.

## Not touched (out of scope, flagging as a discovery)

While confirming `fld_kind` was absent from `buildPaletteGroups`, I noticed
**`fld_phase` ("Fielding phase") also has no palette entry anywhere** — no
`pickSingleton("fld_phase")` call, no `leafSingle`/`singleFamily` in the
"Fielding Stats" group (which only offers "Fielding Wicket Type ▸" and
"Wickets by Batting Position"). It looks like it may be inert by the same
mechanism as fld_kind, but the brief named only `mc_innings_order` and
`fld_kind` for removal, and explicitly said not to touch `fld_pos` — `fld_phase`
wasn't mentioned either way, so I left all of its plumbing (`state.js`
fieldingPhaseActive, drawer.js/drawerInnings.js/pills.js fld_phase code) fully
intact and did not act on this. Surfacing it as a question for the next pass,
not a decision I made unilaterally.

## Verification

- `node --check` on all six touched files: all pass.
- Full-repo grep for `mc_innings_order` / `fld_kind`: zero live-code hits
  outside comments explicitly documenting the removal (plus unrelated
  `export_parquet.py` `fld_kinds` Python variable — a DQ-gate check on the raw
  `kind` column, unrelated identifier, not our filter key).
- Served on localhost:8000, `fetch(cache:'reload')` on all six files, hard
  reload: **zero console errors**.
- Anchors reproduced on screen (Men / Batting / T20 / International,
  2023-07-01→2026-07-02): **2,813 players**; top row **Karanbir Singh 2,454**
  runs; row 11 **SA Yadav 64 MAT / 60 INNS / 1,544 runs / 29.13 AVG / 150.34
  SR** — byte-identical to the standing anchors.
- Confirmed programmatically (`document.body.textContent`) on both the Stats
  popup and the Graph popup (shared drawer.js): `"Dismissal kind"` and
  `"Innings order"` are absent from the DOM; `"Fielding Wicket Type"` and
  `"Innings Number"` are present. Screenshotted the "+ Add condition" palette
  filtered to "field" and "innings" on both surfaces to visually confirm.
- 375px width: Filters popup and the palette render with no horizontal
  overflow; palette scrolls vertically inside its own container.
