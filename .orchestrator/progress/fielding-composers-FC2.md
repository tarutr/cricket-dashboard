# FC-2 — Fielding-composer UI (both surfaces) — progress

Wave FC-2 (frontend-heavy). UI ONLY, NO sacred-query/metric change. FC-1/FC-1b (SQL
`fc__` family + resolver + `buildFieldingCteSql` gating) already done + committed.

## Approach + key risk (stated up-front)
- **columnsPicker.js is SHARED.** Lowest-risk integration: the pop-up passes
  `getDiscipline()` that maps its fielding mode → `"batting"` (a REAL metrics ns, so
  every existing metrics-layer call resolves unchanged — zero remapping of existing
  code) PLUS a new optional `getFieldingMode()` callback for the 2 fielding-only UI
  decisions (which dropdowns render; drop Impact from the Match dropdown). The
  leaderboard never sets it → byte-identical.
- Fielding composers are added to the **Fielding section** of `columnsPaletteModel`
  unconditionally (plain ns) → serves BOTH the leaderboard Fielding dropdown (Surface A)
  and the pop-up Fielding dropdown (Surface B).
- `fc__` count↔per-match is produced **structurally** in `togglePairByCount` /
  `pairForAnyKey` (mode `"permatch"`, `/M` glyph already handled) — NOT added to
  metrics.js `COLUMN_TOGGLE_PAIRS`.
- **KEY RISK:** the pop-up fielding query (`buildFieldingRowQuery`) is a FIXED 6-column
  SELECT. To make composers + per-match *compute*, it must (a) resolve requested `fc__`
  metrics + pass them to the (unchanged) `buildFieldingCteSql` 2nd arg, project
  `fielding_cte.<alias>`, and (b) for per-match, build `pmatch_cte` via the exported,
  UNCHANGED `buildPmatchCteSql` and project `count / NULLIF(match_count,0)` — the metric's
  own definition. Numbers-adjacent → independent DuckDB check required.

## Design calls made (flagged for owner LIVE review)
1. **Over/pos "define ranges" editor** = tally select + from/to number inputs + Add →
   chip list of ranges; confirm spawns one column per range. (Brief: "tick/**define**".)
2. **Pop-up fielding add-menu** = Match (matches ONLY) + Fielding (5 tallies + 6
   composers). Impact/PotM excluded because the pop-up fielding query builds no pom_cte.
   Matches kept (preserve existing functionality). Seed = current fixed 6.
3. **Pop-up per-match denominator** = `pmatch_cte.match_count` (the metric's definition;
   == leaderboard), NOT the pop-up's fielding-scoped "Matches" column.

## Phases
- [x] Phase A — leaderboard: fielding composer entries + editor (6 kinds) + fc__ toggle. VERIFIED LIVE.
- [x] Phase B — pop-up: fielding → Slot[] + shared picker + query projection. VERIFIED LIVE.
- [x] Phase C — Bowler Style availability probe (both surfaces). VERIFIED HIDDEN, no crash.

## VERIFICATION RESULTS (live, localhost:8000, fresh tab, 0 FC-2 console errors)
Anchors byte-identical WITH a fielding composer column added:
- Batting: 2,813 players / Karanbir 2,454 / SA Yadav 64·60·1,544·29.13·150.34.
- Matchup batting: SA Yadav vs Spin = 38·454·140.99. (Matchup code untouched → bowling
  27·177·9 unmoved by construction.)
Surface A (leaderboard): Fielding dropdown offers 5 tallies + Phase/Over Range/Innings/
  Dismissed Position/Dismissed Hand (Bowler Style HIDDEN). Phase→pp/mid/death spawned 3
  standalone rows (count/per-match #//M + sort/highlight/dup/remove + edit pencil); over-
  range + position-range editors define ranges → chips → columns; edit pencil re-opens the
  range editor pre-filled. SA Yadav Ct PP/Mid/Death = 7/11/6, INDEPENDENT DuckDB = 7/11/6.
Surface B (pop-up): Fielding mode now has the picker (Match + Fielding dropdowns only,
  preset hidden); base tallies unchanged (Ct 24/St 0/RO 4/C&B 0/F.Wkts 28/Mat 23); Phase→
  Powerplay computes Ct PP=7; per-match toggle → Ct PP/M=0.11 (7/64 total matches via
  pmatch_cte). Bowler Style hidden, no crash, no console error.
Only console error anywhere = an external ESPN headshot PNG 404 (pre-existing, unrelated).

## NOTE (pre-existing, NOT introduced by FC-2)
The columns picker keeps the add-palette OPEN after picking a composer leaf (keepOpenOnPick);
the FIRST click inside the freshly-opened compose editor is consumed by the palette's
outside-click dismiss. Verified the EXISTING batting "Phase Range" composer behaves identically
(shared openComposeEditor path). Not a regression; a fix would alter shared batting/bowling
composer behaviour → left as a Suggestion for the owner.
