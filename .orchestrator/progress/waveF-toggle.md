# Wave F2 — Segmented-toggle standard + Gender/Discipline migration

Branch `ball-layer`. Builds on F1 (unified panel, already landed) per
`.orchestrator/harmonisation-rejig-plan.md`.

## What was built

1. **New `src/segmentedToggle.js`** (small helper, judgment call explained below):
   - `segmentedToggleHTML(options, {dataRole, ariaLabel})` — renders the SAME
     markup already used by the Stats/Graphs view toggle (index.html/main.js)
     and the player-page Batting/Bowling toggle (playerPage.js): a `.segmented`
     wrapper of `.segmented__btn` buttons. No new visual invented.
   - `wireSegmentedToggle(el, onSelect)` — click-delegates to `onSelect(value)`,
     returns `{sync(value)}` to re-highlight the active button after external
     state changes.
   - **Judgment call:** built the helper rather than inlining, because
     filters.js needed the SAME render+wire+sync trio twice (Gender,
     Discipline) in one file — factoring it once avoided a second hand-rolled
     copy of what main.js and playerPage.js each already wrote independently
     ad hoc. Did NOT touch main.js or playerPage.js to adopt the helper
     retroactively — those files are outside this wave's ownership
     (`src/filters.js`, `styles.css`, optionally a new file only). Flagging as
     a Wave S candidate: folding all three call sites onto this one helper
     would leave exactly one implementation of the pattern instead of three.

2. **`src/filters.js`** — Gender and Discipline controls in `mountFilters`
   (dual-mounted: Stats Filters popup + Graph Filters popup) migrated from
   native `<select class="select">` to the segmented toggle:
   - Markup: `segmentedToggleHTML([...], {dataRole:"gender"/"discipline", ...})`
     replaces the two `<select>` blocks. `data-role` kept identical to the old
     selects', so the existing `container.querySelector('[data-role="..."]')`
     lookups needed no change.
   - Wiring: `wireSegmentedToggle` replaces the two `change` listeners.
     Same store keys/values (`gender`: "male"/"female", `discipline`:
     "batting"/"bowling"), same clearing side-effects on gender switch (teams,
     profile, event, venue, opposition, eventSeasons, stage), same
     `onDisciplineChanged`/`onChange` calls. A click on the already-active
     button is a guarded no-op (mirrors a `<select>`'s "change" not firing on
     re-picking the same option).
   - `render()` now calls `genderToggle.sync(state.gender)` /
     `disciplineToggle.sync(state.discipline)` instead of setting `.value`.
   - Updated the stale in-file comment (previously described a Round-3 decision
     that had swapped these FROM segmented TO select — now reversed back per
     THIS wave's owner-approved harmonisation plan, not a re-litigation of that
     old call).

3. **`styles.css`** — removed one now-dead rule: `.filter-group--gender .select,
   .filter-group--discipline .select { align-self: flex-start; }` (lines
   ~405-409). Dead because neither filter-group renders a `.select` anymore;
   fully superseded by the pre-existing generic
   `.filter-group .segmented { align-self: flex-start; }` (line ~415), which
   already anticipated exactly this control shape (leftover CSS scaffolding
   from before Round 3's select swap — confirms this migration is a clean
   reversion onto CSS that was already sitting there unused). No other
   `.segmented`/`.filter-group--gender`/`.filter-group--discipline` CSS
   touched — all of it already targeted `.segmented`/`.segmented__btn`
   correctly for both the single-row desktop layout and the 899px/1149px/640px
   responsive blocks.

## Verified

- `node --check src/filters.js src/segmentedToggle.js` — pass.
- Served localhost:8000, `fetch(cache:'reload')` on both changed JS + CSS,
  reloaded. **0 console errors** on boot.
- Gender + Discipline render as segmented toggles (Men/Women, Batting/Bowling)
  in BOTH the Stats Filters popup and the Graph Filters popup (confirmed via
  accessibility tree — both show as `button "Men"/"Women"/"Batting"/"Bowling"`
  under each respective dialog).
- **Anchor reproduced on screen**: Men / Batting / T20 / International,
  2023-07-01 → 2026-07-02 → **2,813 players**, top row **Karanbir Singh
  2,454** runs, **SA Yadav row 60 INNS / 1,544 runs / 29.13 avg / 150.34 SR**
  — all exact matches.
- **Independent DuckDB check** (hand-written, not reusing the app's own
  aggregation shape): `SELECT COUNT(*) FROM (SELECT batter_id, batter_name
  FROM batting WHERE gender='male' AND match_type IN ('T20','IT20') AND
  team_type='international' AND match_date BETWEEN the two anchor dates
  GROUP BY batter_id, batter_name)` → **2813**, confirming the toggle writes
  `state.gender`/discipline-view correctly.
- **Bowling sanity flip**: Discipline → Bowling → leaderboard switches to
  bowling columns (WKTS/AVG/ECON/SR/BBI), **2,049 players** (the documented
  bowling-scope baseline). Flipped back to Batting → 2,813 again, anchor holds
  after a round trip.
- **375px mobile**: both the Stats Filters popup and Graph Filters popup
  render the Gender/Discipline toggles fitting inside the viewport (labels
  ellipsis to "Wo…"/"Bowli…" under the existing mobile CSS rules, which
  already anticipated this exact control). `document.documentElement.
  scrollWidth === clientWidth === 375` — no horizontal page scroll.

## Files touched

- `src/segmentedToggle.js` (new)
- `src/filters.js` (Gender + Discipline markup/wiring only — buildScopeClauses
  and every other filter untouched)
- `styles.css` (one dead-rule removal only)

## Query builders

`buildScopeClauses` / `buildCoreScopeClauses` in filters.js — byte-identical,
not touched. This wave is markup + wiring only.

## Notes for later waves

- main.js's Stats/Graphs view toggle and playerPage.js's Batting/Bowling
  toggle still hand-roll their own render/sync/click-delegate — not migrated
  onto `segmentedToggle.js` (out of this wave's file ownership). Wave S
  candidate.
