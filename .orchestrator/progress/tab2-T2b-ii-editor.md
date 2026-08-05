# T-2b-ii — the INTERACTIVE editor + row management (progress)

Branch `ball-layer`, main working tree. NO git (orchestrator commits).
Numbers-sacred (CLAUDE.md Rule 1). Flag-OFF proofs vs R2 (this wave adds NO
opponent/window UI, so nothing here needs the local ball snapshot).

## Approach (stated for the record)
- The code-seeded T-2a/T-2b-i rows are GONE. Rows are now user-defined via a real
  editor modal, `src/playerFilterEditor.js` (NEW), opened by the tab's "Add Filter
  Row" button (add) or a row's pencil (edit, pre-filled).
- The editor mounts the REAL palette (`createAddPalette` + `createPaletteGroupsBuilder`
  surface:"popup") whose leaf run() calls the editor's OWN `pickMetric`, appending a
  canonical condition to a LOCAL draft (never the global store). Boolean vs numeric
  routing = `isBooleanMetric(key,disc)` (Ducks/Not Outs/dismissal-type/PotM → Y/N;
  else numeric with ≥/≤/=/between). Multiple conditions per row (one AND group).
- Per-row scope (Format / Team type / Date) lives INSIDE the modal, STICKY: a new
  row pre-fills from the LAST committed row (`lastScope`); a first row from the
  pop-up's effective scope (so a no-condition default row == the leaderboard row).
- Row table: sticky first cell = pin + first-condition literal label + (i) (full
  list, `title`) + pencil + ✕, all inline (no pills). Column-sortable (▲/▼, NULL
  last) + pin-to-top, both reading a per-row `rowData` cache (sort/pin never
  re-query). Empty state "No filtered rows yet". Both buttons "Add Filter Row"
  (edit modal title "Edit Filter Row", commit "Save" — terminology-note assumption).

## Palette restriction (paletteGroups.js surface "popup" ONLY — leaderboard byte-untouched)
- Metric leaf offered iff `metricSliceable(key,disc)` (new optional dep) = the slice
  engine's `isPopupFilterMetric` → the ✅ per-innings set; ❌ column-only metrics
  (Average, Bowling SR, High Score, Best, Matches, 50s/100s, Balls per…, Balls per
  Dismissal) fall out with NO drift-prone key list. Innings Score / Wicket Hauls
  relabel to plain (full-operator numeric). PotM (Y/N) added as a bespoke boolean leaf.
- ALL scope singletons WITHHELD (leafSingle/singleFamily/matchResultFamily → null on
  popup): Team, Opposition, Event, Venue, Stage, Match/Toss Result, Innings Number,
  Matchup Vs, opponent player, delivery window, fielding. See DEVIATION below.

## DEVIATION from brief #1 (flagged, NOT silently narrowed) — needs owner/orchestrator call
Brief #1 says KEEP scope filters (Innings Number / Opposition / Event / Venue / Stage
/ Result / Toss / Team) + Matchup (vs bowling style / vs batting hand / vs opponent
player / batting position) in the pop-up palette. But the T-2b-i engine wired ONLY the
numeric/boolean per-innings slices (+ per-row opponent/window THREADING, no editor).
The scope singletons + matchupVs have NO working per-row data path in this tree:
- Scope singletons would need the row to carry those state fields + `buildRowState`
  to set them (→ `buildScopeClauses` applies them, numbers-safe) + REUSE of the
  drawer's store-coupled value editors (mountTeam/Opposition/Event/… in drawerInnings.js).
- vs bowling style / vs batting hand / batting position route through
  `buildMatchupQuery`, which the tab deliberately does NOT use (T-2b-i: "the tab never
  combines a per-innings slice with a Vs in this wave") — a genuine engine gap.
- vs opponent player + delivery window ARE engine-ready (T-2b-i threading) but still
  need their picker editors.
Showing any of these without a working query would be a DISHONEST filter (SPEC §8.4),
so they are held back for now, NOT dropped from the design. Recommend a follow-up
data-path wave (data-engineer for matchupVs; store-adapter reuse of drawerInnings
editors for scope singletons + opponent/window) before they re-enter the palette.

## Status — Phase 1 (numeric/boolean editor + row mgmt + sticky scope) COMPLETE + VERIFIED (flag-off vs R2)
- [x] paletteGroups.js popup restriction; playerFilterEditor.js (new); playerFiltersTab.js
      rewrite; styles.css (editor modal + row-action icons). node --check all OK.
- [x] Leaderboard byte-identical: 2,813 players / Karanbir 2,454 (on screen); leaderboard
      "+ Add condition" palette intact (full taxonomy, Average etc. still present).
- [x] Pop-up palette shows exactly the ✅ set (batting + bowling verified on screen);
      ❌ Bowling Average + Bowling SR confirmed ABSENT; PotM (Y/N) present; Innings Score /
      Wicket Hauls plain.
- [x] UI-added slices == independent raw-DuckDB (NOT the app's shape), SKY 271f83cd, per-row
      scope T20/Intl/2023-07..2026-07:
        Innings Score ≥ 100 → 1 / 100 / SR 178.57
        PotM = Yes         → 5 / 405 / SR 186.64
        Innings Score ≤ 120 → 60 / 1,544 / 29.13 / 150.34  (== his full record == leaderboard row)
        Runs ≥ 30 AND 6s ≥ 2 → 17 / 1,038  (multi-condition AND)
- [x] Sticky scope pre-fill (T20/Intl/dates carried to the next Add Filter Row).
- [x] Per-row scope controls (Format checkboxes / Team-type segmented / Date months) apply.
- [x] Edit (pencil) pre-fills op+value+scope; ✕ deletes; column sort ▲/▼ (NULL last) +
      pin-to-top; first-condition literal label + (i) full list; empty state; both buttons.
- [x] Bowling discipline: palette + Core columns correct; rows re-query.
- [x] 0 console errors across boot + search + pop-up + Filters tab + all interactions.
- [ ] Opponent-player + delivery-window EDITORS (engine-ready; not built — see DEVIATION).
      → the flag-on "two rows, different opponents/windows don't collide" verification is
      NOT exercised this wave (no UI sets them yet; the T-2b-i threading is untouched + intact).

## Concerns / open questions (for the owner via orchestrator)
1. The DEVIATION above (scope singletons + matchupVs withheld) — proceed to wire them next, or accept numeric/boolean-first?
2. Edit-mode commit button reads "Save" (terminology-note assumption). Confirm vs "Add Filter Row".
3. Rows persist across a discipline switch (from T-2a) — a batting-worded row on the bowling
   tab shows the UNFILTERED bowling record (its batting condition can't slice bowling). Reset
   rows / keep per-discipline row sets / leave as-is? (Product call — not changed unilaterally.)
4. `src/playerFiltersTab.js` is 799 lines (SPEC §8.3 ~600 flag). The numbers-critical slice
   engine (~200 lines) could extract to its own module — deferred (don't churn verified code).
