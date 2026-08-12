# Wave A — Corrections & restores (2026-08-12)

Owner-approved display/label/layout fixes, numbers-safe (CLAUDE.md Rule 1 respected — no
sqlExpression / buildQuery / buildMatchupQuery / buildScopeClauses touched).

## The 7 fixes — all DONE, all verified live on localhost:8000

1. **[#28] Boundary Runs restored (batting column).** `src/columnsPicker.js` HIDDEN_COLUMN_KEYS
   (~line 655): removed `"boundary_runs"`. Already present in BATTING_DETAILED_ORDER +
   DETAILED_TOTAL_KEYS (no order-array change needed). Verified: appears under Batting ·
   Detailed Stats, adds as a #/% toggle column, Karanbir Singh = 2,020 (= 4×199 + 6×204,
   consistent with the anchor's own 4s/6s).

2. **[#25] Boundary % Conceded restored (bowling filter).** `src/paletteGroups.js`: removed
   `"boundary_pct_conceded"` from `DELETED_FILTER_METRIC_KEYS` (~line 87) + added
   `leafMetric("boundary_pct_conceded", "Boundary % Conceded")` to the Bowling · Detailed
   Stats group. Verified: appears in the bowling "+ Add condition" palette, filters correctly
   (≥10 → 1,670 of 2,049 bowlers), 0 console errors.

3. **[#18] Parametric filter renames.** `src/paletteGroups.js`: `leafMetric("innings_score_ge", …)`
   → "Innings Score (Min/Max)"; `leafMetric("wicket_hauls_ge", …)` → "Wicket Hauls (Min/Max)".
   Checked the columns-picker's own parametric add-menu entries (`sectionLabel` in
   `COMPOSED_PARAM_SPECS`, metrics.js) — they already read "Innings Score Range" / "Wicket
   Haul" (not plain), so per the task's own conditional they did NOT need changing; left as-is.
   Verified both surfaces live.

4. **[#19] NBSR full name in filters, short in columns.** `src/metrics.js`: reverted
   `running_sr.label` → "Non-Boundary Strike Rate" for BOTH batting (~line 569) and
   matchup_batting (~line 1993); `shortLabel` stays "NBSR" in both. `src/paletteGroups.js`
   leaf override updated to match. Verified: filter palette + columns add-menu both read
   "Non-Boundary Strike Rate" (batting AND Vs-Spin matchup_batting); the actual table column
   header reads "NBSR" (table.js reads shortLabel, confirmed via DOM query).

5. **[#20] Bowling "Boundary Run %" → "Boundary Run % Conceded" + Conceded audit.**
   `src/metrics.js`: bowling `boundary_runs_pct` (~line 979) label → "Boundary Run % Conceded",
   shortLabel → "Bdry Run% Con"; same for matchup_bowling's copy (~line 2308). Batting's
   identically-named metric (label "Boundary Run %") is UNTOUCHED, both plain and matchup.
   `src/paletteGroups.js` bowling leaf override updated to match.
   **Audit of every other bowling metric for a missing "Conceded" suffix:** compared every
   bowling label against every batting label (metricsFor("bowling"/"batting", ["T20"])). Only
   `boundary_runs_pct` collided verbatim (label AND shortLabel identical to batting's). Dot
   Ball % Conceded / Boundary % Conceded / 4s·6s Conceded already carry it (per the task's own
   "leave those" list). Wides / No-balls / Maidens / Economy / Wickets / wkt_* types have no
   batting-namespace label collision requiring the same disambiguator (wkt_bowled/wkt_lbw/etc.
   DO collide with batting's out_bowled/out_lbw/etc., but those are bowling ACHIEVEMENTS, not
   "conceded" quantities — outside the stated scope; flagged below under Concerns, not changed).
   No other bowling metric qualified. Batting untouched throughout.

6. **[#26] Match columns dropdown flattened.** `src/columnsPicker.js` `columnsPaletteModel`:
   merged the "Basic Stats" + "Impact" sub-sections into a single unnamed group (`section("", …)`)
   — Player Matches, Player of the Match Count, Matches Won, Matches Lost, Matches Tied, No
   Result, Toss Won, in that order (unchanged item order, only the two headings removed).
   `styles.css`: added `.palette__group-header:empty { display: none; padding: 0; }` so the
   empty-name group renders no visible heading bar (no gap). Verified: Match dropdown is a flat
   list, search finds "Toss Won" / "No Result" directly with no sub-heading text visible.

7. **[#17] Four dropdowns moved above the chosen list.** `src/columnsPicker.js`
   `buildInlineHTML`: swapped concatenation order (`buildAddMenuHTML` now first, then
   `buildChosenHTML`). Confirmed `wireChosen` / `mountColumnPalettes` / `rerenderInline` all
   locate elements via `querySelector('[data-role=...]')`, never DOM position — reorder is
   layout-only. Also fixed the now-stale empty-state copy ("add some from the menus below" →
   "…above") and a stale comment about the trigger repositioning on add (no longer needed once
   the bar is above, kept the defensive `repositionCurrent()` call, updated its comment).
   Verified: dropdowns render first, chosen list (starting with "Player Matches") below them.

## Verification
- `node --check` on all three touched files: clean.
- Live on localhost:8000, Men/T20/International/2023-07-01→2026-07-02:
  - 2,813 players; Karanbir Singh 2,454 runs (top row) — unmoved.
  - SA Yadav: 60 inns / 1,544 runs / 29.13 avg / 150.34 SR — unmoved.
  - SA Yadav vs Spin (matchup_batting): 38 inns / 454 runs / SR 140.99 — unmoved.
  - 0 console errors at every step (batting, bowling, matchup_batting Vs Spin,
    matchup_bowling Vs Right-hand-bat).

## Also fixed (small, inline)
- Empty-state text "add some from the menus below" → "…above" (now-accurate after #17's reorder).
- Stale comment on the palette-reposition call after #17 (documented, not behavioural).

## Suggestions (not built) / observations for the owner
- The wicket-type collisions (wkt_bowled/"Bowled" vs batting's out_bowled/"Bowled", and the LBW/
  Caught/Stumped/Hit-Wicket equivalents) are genuine label collisions like boundary_runs_pct was,
  but they're bowling ACHIEVEMENTS (wickets taken by method), not "conceded" quantities — task
  #20 scoped the audit to "measuring something conceded/against the bowler", so I left these
  untouched. Flagging in case the owner wants a separate disambiguation pass on these later.
- Renaming `running_sr.label` and bowling `boundary_runs_pct.label` in metrics.js also changed
  the text shown in the COLUMNS add-menu (not just the filter palette) for both, since
  `columnsPicker.js`'s add-menu uses the metric's shared `.label` field too (no separate label
  source for that surface). This is a side effect of "ONE metrics module" (SPEC §8.2) — the
  columns add-menu now also reads "Non-Boundary Strike Rate" / "Boundary Run % Conceded" instead
  of the short forms, while the actual column HEADER still reads NBSR / Bdry Run% Con via
  shortLabel. Not asked for explicitly, but unavoidable without adding a second per-surface label
  field; flagging so the owner can confirm this reads fine (it looked correct/clearer in testing).

## Concerns
None — all 7 fixes verified live, anchors byte-identical, 0 console errors, no STOP-RULE
triggers (nothing here required a query/number change).
