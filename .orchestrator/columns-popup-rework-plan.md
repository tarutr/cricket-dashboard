# Columns + Filters + Pop-up rework — build tracker (owner-approved 2026-08-12)

Source: owner's live flag-off review (34 critiques) + follow-ups. Cache-ghosts (#27/#29/#30 + "columns broken")
were a stale ES-module cache, NOT defects — columns rejig is live + correct on `ball-layer` (diagnosed 2026-08-12).
Contract: CLAUDE.md (numbers sacred; owner is PM — design-gate items need sign-off BEFORE build). NOTHING pushed.

## DESIGN-GATE items (active — NOT backlog; build only after a design chat + owner sign-off)
- **AND/OR "match any/all"** [#22] — KEEP what's built; discuss implementation; build on it. Do NOT touch until discussed.
- **Wave D behaviour** — orchestrator writes a tight spec → owner confirms → build.
- **Wave E pop-up unification + popup-within-popup grid** [#16] — orchestrator writes a reconciliation map → owner confirms → build.

## WAVES
| Wave | Items | Nature | Status |
|---|---|---|---|
| **0 — Cache fix** | Make local review immune to stale ES-module cache (version stamp / no-cache review server) | infra | IN PROGRESS |
| **A — Corrections & restores** | Restore Boundary Runs column [#28] · restore Boundary % Conceded (balls) filter [#25] · "Innings Score (Min/Max)" / "Wicket Hauls (Min/Max)" [#18] · NBSR→"Non-Boundary Strike Rate" in FILTERS, NBSR only as column header [#19] · "Boundary Run % Conceded" (bowling) + sweep bowling metrics for missing "Conceded" [#20] · remove unapproved Match-columns sub-sections [#26] · move the 4 column dropdowns to the TOP [#17] | display/label/layout — numbers-safe | IN PROGRESS |
| **B — Dropdown & row UX** | Remove inline sub-options from ALL dropdowns [#5] · composer edit → simple dropdowns, count/% out of edit mode [#35] · filter rows adopt columns-row design + width 75% desktop/tablet, full mobile [#6] · number boxes sized-to-entry, digits centred [#21] · add-more dropdowns open in a fixed full-view panel like the graph dropdowns [#23] | UX/CSS | TODO |
| **C — Filter data & completeness** | Bowling types: CHECK registry vs UI → complete + order pace→spin [#9] · game-counts on Opposition + audit others [#13] · bowling runs-conceded-by-source % (4s vs 6s conceded) filter+column [#24, DESIGN SIGN-OFF before build] · INVESTIGATION only: bowling-hand data check [#8] | numbers-critical | TODO |
| **D — Order / mapping / presets** ⚠ spec gate | selection-order drives column order [#14] · every filter maps to a relevant column [#15] · no pre-chosen columns on first open; Core default after first Search if untouched [#1,#4] · preset picker in pop-up + preset/filtered behaviour [#2] · sort by most-innings until user sorts, remembered until column/filter removed [#3] | behaviour | TODO (spec first) |
| **E — Pop-up unification** ⚠ map gate | rebuild pop-up filter+column UI to reuse the leaderboard's EXACT components [#11,#32,#33] · scope pop-up filter options to the player's own data [#12] · PotM consistency + full parity audit [#10] · popup-within-popup grid picker (desktop/tablet) [#16] | big refactor | TODO (map first) |

## BACKLOG (owner-deferred)
- Pop-up **Overview** fixes [#31] — after the preset work.

## Review checkpoints
- Owner re-reviews after Waves A–C (leaderboard), then again after E (pop-up). Each build wave: recount anchors +
  fresh code review; numbers-critical waves (C) get independent DuckDB. Orchestrator commits + reviews each wave.

## Standing constraints
- Numbers sacred: no `buildQuery`/`buildMatchupQuery`/`buildScopeClauses`/`sqlExpression` change except the ONE new
  metric family in C (#24, sign-off first, independent DuckDB). Restores (#25/#28) un-hide EXISTING metrics (display).
- Anchors: 2,813 / Karanbir 2,454 / SA Yadav 60·1,544·29.13·150.34 · Bumrah vs RHB 27·177·9 · SKY vs Spin 38·454·140.99.
