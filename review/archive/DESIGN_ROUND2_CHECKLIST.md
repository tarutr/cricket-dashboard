# Design round 2 — owner verification checklist

Everything built on `polish-b1-mechanical` (decisions 42–45), for item-by-item owner
review on localhost:8000 (hard-refresh first: Shift+reload). The owner responds with
item numbers + verdicts ("14 fine / 16 raise to 5 / 54 change X"). Items marked
**[RULING]** need an explicit owner decision.

## A · Header & scope strip
1. Tabs renamed: header shows only **Stats** / **Graphs**, top right.
2. Batting|Bowling toggle moved out of the header into the filter panel (DISCIPLINE, after GENDER).
3. FORMAT is a checkbox dropdown ("T20"; tick ODI → "T20 +1"; last-checked box is
   locked with tooltip; closes on outside click/Escape).
4. TEAM TYPE is a checkbox dropdown: International / **Domestic** (Club renamed
   everywhere); both ticked = old "Both"; the third button is gone.
5. Subtitle mirrors scope and never says "min N innings" anymore.
6. Boot state: pulsing display-font "Loading…", tabs keep their dark selected look.
7. Footer "debug console" link removed.

## B · Search
8. Typing in Search players never changes/blanks the table — a dropdown appears instead.
9. Dropdown: ≤8 players with meta ("India · Top-order batter" / muted "No profile
   available") + last row "Filter the table to names matching …".
10. Clicking a player opens their popup regardless of table filters (V Kohli works).
    Arrow keys + Enter + Escape work.
11. The filter row narrows the table (V Kohli = 1 player, IS in the table now) with a
    removable pill `matching "kohli"` + honest subtitle.
12. Toast when the filter finds 0 rows but the name matches real players ("…may be
    excluded by your current filters") — e.g. under a Runs ≥ 5000 condition.

## C · Results table
13. Ungated defaults: 2,813 batting / 2,049 bowling players (3 batting rows are
    known dual name-spellings of the same id — data honesty, not a bug).
14. Row count phrased "2,813 players" (localized).
15. Min innings exists only as an Advanced condition ("Innings ≥ 10"), pills as such.
16. **[RULING]** Thin-sample rates render muted with title "Based on N balls/
    dismissals". Floors: balls 30, innings 5, dismissals 3, wickets 3, boundaries 3.
    Open question: raise average's dismissals floor 3 → 5? (A 4-dismissal avg 98.75
    currently tops the sort un-muted.)
17. Toolbar persists during re-query (controls never vanish; only the table overlays
    "Running query…").
18. **Graph** + **Columns** clustered flush right in the toolbar; Graph disabled with
    "Show results first" pre-query.
19. Sticky first column + sorting unchanged.

## D · Columns picker
20. Button says "Columns" in both modes, same position.
21. Dismissals section: 6 real kinds + one "Show as %" toggle + collapsed
    "▸ Rare dismissals" for the exotic six.
22. % toggle swaps checked columns (Ct ↔ Ct %).

## E · All-filters drawer
23. Sections: Team (one dropdown) → Player profile → Innings (position only) →
    Advanced (Against (opposition), Has ever played for (career), Stat conditions).
24. Batting position = multi-select dropdown ("Any position" / "1, 2, 3" / "4 selected").
25. The two renamed team filters live under Advanced with those exact labels.
26. One pinned remove × per condition row; no inner Apply/Clear (bottom bar only).
27. Metric-without-value blocks Apply with inline "Enter a value or remove this
    condition" — nothing silently dropped.
28. Pills read the condition ("Runs ≥ 300"); subtitle appends it (3+ collapse to
    "N stat conditions" in the subtitle only).
29. Women view: profile section greys with the honest note (unchanged).

## F · Player popup
30. Real headshots for ~1,360 profiled players (photo circle left of the name).
    NOTE: sandbox blocked the photo host during verification — fallback path was
    verified; owner must confirm photos render on his machine.
31. Everyone else (incl. all women): designed two-tone initials medallion + honest note.
32. Batting | Bowling toggle under the header; per-discipline tight grid (tiles →
    position+opposition → how-out+build-up → matchups); other discipline lazy-loads.
33. Header row: back link + toggle left; **Filters** + **Graph this player** right;
    × always top-right.
34. Popup Filters drawer: Vs Spin on SA Yadav → tiles 38 inns / 454 runs / SR 140.99,
    coverage "913 of 1,027 balls", scope line "· vs Spin", removable pill + Reset.
35. Honest refusals under Vs: position/opposition/build-up sections grey with
    "Can't split X by Vs here".
36. Vs how-out titled "Bowler-credited dismissals vs X" (no run-outs / not-out math).
37. Date and position slices recompute all sections (SA Yadav pos 3 = 22 inns/551 runs).
38. Popup filters are popup-local; cleared on close/player switch; never touch the page.
39. Unchanged: ×/backdrop/Escape, in-popup search, scroll reset.

## G · Graphs — shared
40. Nine tiles (…+ Benchmark), 3 per row; one carries "Recommended"; unusable types
    grey with a reason tooltip.
41. Captions under the picker change per type.
42. Roster = "N of M selected" checkbox dropdown with pool ranks + per-row remove ×,
    plus Manual | Best | Worst when the pool exceeds the cap.
43. Cap = block-not-remove: Radar shows "6 of 15", 9 disabled with "Max 6 for this
    chart type — untick one first"; switching back restores all 15.
44. Honest titles: "top 15" / "top 15 by batting average" / "N players" per roster
    provenance; user-edited titles survive roster edits, reset on type/metric change.
45. ✎ edit affordance on title/subtitle; Copy PNG next to Export PNG.

## H · Graphs — per type
46. Bar: leader on top, all labels at any width, value labels never clip,
    Bars ⇄ Dots toggle.
47. Donut: top 7 + "Other (N players)".
48. Scatter: median quadrant guides; labels clamped inside the plot.
49. Radar: side-by-side mini-radars, shared scale, no overlays.
50. Phases: grouped bars per metric family (bowling honestly 2-phase).
51. Slope: explicit Window A/B month pickers (default half-split); green/red =
    improved/declined direction-aware; label declutter; windows in title+footer;
    "N of M have innings in both windows". Verified: SA Yadav 152.01/148.25.
52. Dumbbell: batting+Men only (honest disables); Side A/B (default Pace vs Spin);
    coverage in tooltips; Stats-in-matchup-mode → Graph lands on the dumbbell.
    Verified: Waseem Muhammad 150.9146/155.4324.
53. By year: 30-ball floor fades thin years (decision 45); gaps never fake zeros;
    percent metrics selectable (dot% verified per-year); cap 6.
54. **[RULING]** Benchmark: anchor = 100% line; rows grouped Volume/Tempo/Consistency;
    bar = best other as % of anchor with name; red "#1 <name>" when beaten; anchor
    value + rank right; floors in footer; sub-floor outliers excluded from rankings
    (600-SR-off-1-ball case verified). Open: (a) "(off scale)" caption clips at 375px
    — should wrap; (b) default anchor = first ticked player — better = seed-metric
    leader?
55. "Graph" button: top-15-by-current-sort bar with adopted metric + honest title.
56. "← Back to your table" (bridge only) now RETURNS to results; tab switches
    preserve results; filter changes still blank (no-auto-search intact).
57. "Graph this player" adds to roster + jumps to Graphs.

## J · Mobile (~375px)
58. Scope strip = compact stacked dropdowns.
59. Popup true full-screen; header row wraps cleanly; vs-opposition table no longer
    clips (long team names wrap).
60. All nine chart types: zero sideways page scroll (systematically checked).
61. Tap targets ≥40px (pill ×, popup close, checkboxes, small toggles).

## K · Invisible
62. Every number-touching change re-verified vs raw R2 with independent derivations
    (SA Yadav career + vs Spin, Bumrah 27/177/9, per-year recombination, slope
    windows, dumbbell sides, benchmark rankings, ungated baselines 2,813/2,049).
    Found+fixed: DuckDB BigInt samples silently disabled dismissals-based muting.
63. README real sections (feedback marked NOT BUILT); old export script untracked;
    d4-* branches pruned; dead CSS deleted; decisions 42–45 logged.

## L · Open items **[RULING]**
L1. Item 16's average floor (3 → 5 dismissals?).
L2. Item 54's Benchmark cosmetics (caption wrap; default anchor).
L3. v1 extras not adopted: glossary tooltips on column headers, per-chart "how to
    read this" info panel, CSV export, click-to-highlight on charts, 🎲 Randomise.
    Adopt any?

## After sign-off (roadmap, not in this review)
Merge gate to main → feedback form (Supabase, RLS anon INSERT only) → performance
audit → file splits (table.js/graph.js/metrics.js/state.js/drawer.js over the
600-line cap; dead formatMetricValue in charts.js goes with the split).
