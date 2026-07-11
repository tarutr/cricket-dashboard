# Design round 2 — owner verification decisions

Assume all points have been verified, unless there is a specific comment relating to that particular section/point number. My comments are italicised.

---

## A · Header & scope strip

*ALL DONE*

---

## B · Search

- Typing in Search players never changes/blanks the table — a dropdown appears instead. *– DONE – But clicking on a player opens the player popup rather than adding them to the table? The placement of the search bar indicates that you are searching for players to add. Perhaps we should move the search bar with this functionality to the header, while having this placement have a search bar that adds players to the stats selection?*

- Toast when the filter finds 0 rows but the name matches real players ("…may be excluded by your current filters") — e.g. under a Runs ≥ 5000 condition. *– the feature is there, but the matching doesn't exist*

- *Overall – basic design functionality is missing. Think about how this section should look with different widths (desktop/tablet/mobile).*

---

## C · Results table

- [RULING] Thin-sample rates render muted with title "Based on N balls/ dismissals". Floors: balls 30, innings 5, dismissals 3, wickets 3, boundaries 3. Open question: raise average's dismissals floor 3 → 5? (A 4-dismissal avg 98.75 currently tops the sort un-muted.) *– Sure.*

- Graph + Columns clustered flush right in the toolbar; Graph disabled with "Show results first" pre-query. *– Nope. They are still flush left next to the group rows dropdown.*

- Sticky first column + sorting unchanged. *– This works, but needs a change. The width of the first column needs to be much thinner (especially for tablet/mobile widths where the stick columns takes over the entire width), and with user customisable width – let the columns drag and drop left and right (apart from the sticky columns)*

---

## D · Columns picker

*ALL DONE*

---

## E · All-filters drawer

- Sections: Team (one dropdown) → Player profile → Innings (position only) → Advanced (Against (opposition), Has ever played for (career), Stat conditions). *– this is an overall terrible classification. Player profile should have team, role, batting hand, **most common** batting position **(rename that dropdown)**, bowling style (rename that dropdown). We don't need a separate "Ever played for" team category – that's what team should do. Against opposition doesn't need its own dropdown; it can just be another selection in the advanced filters dropdown.*

- Women view: profile section greys with the honest note (unchanged) *– don't grey out the dropdowns, just remove the ones that don't exist and have the disclaimer line.*

---

## F · Player popup

- Batting | Bowling toggle under the header; per-discipline tight grid (tiles → position+opposition → how-out+build-up → matchups); other discipline lazy-loads. *– vs opposition rows need to be limited. Have Wicket Type (rename How Out) and Progressive Scoring (rename scoring by balls faced) in the left side under batting position. Evens out the long v opposition right section where the rows can be limited to the length of the left side.*

- Honest refusals under Vs: position/opposition/build-up sections grey with "Can't split X by Vs here". *– why have these at all? If there is no ability to do v bowling type, etc. just…don't have it as an option?*

- Date and position slices recompute all sections (SA Yadav pos 3 = 22 inns/551 runs). *– works, position should be regular position "R. Pos." with a hover description. Correct this everywhere on the dashboard.*

- *Overall – basic design functionality is missing. Think about how this section should look with different widths (desktop/tablet/mobile).*

---

## G · Graphs — shared

- Nine tiles (…+ Benchmark), 3 per row; one carries "Recommended"; unusable types grey with a reason tooltip. *– why are we auto filling the graphs? It leads to all kinds of bad decision like changing metrics and returning to default "chosen" metrics for each graph – just grey out the graph options that are not available. Speaking of though, why is dumbbell greyed out? Don't have default settings, and have persistent memory. Greyed out means no graph loads, but you get a sentence telling you why, and what to do to get a graph.*

- Captions under the picker change per type. *– these aren't great. Get rid of them.*

- *Overall – remove the "default" settings. If there was a filter run in the stats section, just use that (even if they press graph in the header). If no search was run, just have it empty. No need to pre-fill a graph.*

---

## H · Graphs — per type

- Radar: side-by-side mini-radars, shared scale, no overlays. *– maximum 2 rows of radars (so 3 radars per row, rather than 2 radars in 3 rows for the 6 maximum).*

- Slope: explicit Window A/B month pickers (default half-split); green/red = improved/declined direction-aware; label declutter; windows in title+footer; "N of M have innings in both windows". Verified: SA Yadav 152.01/148.25. *– the slope numbers clashing with the lines. Do it differently; put the player name (stat) on both sides of each line.*

- Dumbbell: batting+Men only (honest disables); Side A/B (default Pace vs Spin); coverage in tooltips; Stats-in-matchup-mode → Graph lands on the dumbbell. Verified: Waseem Muhammad 150.9146/155.4324. *– I don't know how to use dumbbell. It's just greyed out and unusable.*

- By year: 30-ball floor fades thin years (decision 45); gaps never fake zeros; percent metrics selectable (dot% verified per-year); cap 6. *– is this not just a line graph? Why are we calling it "By Year"?*

- [RULING] Benchmark: anchor = 100% line; rows grouped Volume/Tempo/Consistency; bar = best other as % of anchor with name; red "#1 \<name\>" when beaten; anchor value + rank right; floors in footer; sub-floor outliers excluded from rankings (600-SR-off-1-ball case verified). Open: (a) "(off scale)" caption clips at 375px — should wrap; (b) default anchor = first ticked player — better = seed-metric leader? *– benchmarking line should be one vertical line that is unbroken rather than different lines per bar.*

- "Graph" button: top-15-by-current-sort bar with adopted metric + honest title. *– remove this default. Have it empty if no searches were run in the stats section. Have unrecommended graphs greyed out but clickable. If you click on them, it tells you what you need to do generate a graph (add players, choose x metrics, etc.)*

- "← Back to your table" (bridge only) now RETURNS to results; tab switches preserve results; filter changes still blank (no-auto-search intact). *– couldn't see this anywhere?*

- "Graph this player" adds to roster + jumps to Graphs. *– have a middle popup that asks for specific graph and metric choices. Don't just randomly choose a graph.*

- *Overall – basic design functionality is missing. Think about how this section should look with different widths (desktop/tablet/mobile). In desktop, the graph names don't fit with the graph square boundaries (the writing overshoots the boundary, so you can only see "**Benchmar**" instead of "Benchmark"*

---

## J · Mobile (~375px)

- Scope strip = compact stacked dropdowns. *– this looks ugly. We need a better solution.*

- All nine chart types: zero sideways page scroll (systematically checked). *– we need to find a fix for this because they will be making up graphs that won't look anything like the export graphs. Not sure of the solution here.*

- *Overall – lots of other changes to be made. Mentioned above.*

---

## K · Invisible

*ALL DONE*

---

## L · Open items [RULING]

**L1.** Item 16's average floor (3 → 5 dismissals?). *– do it.*

**L2.** Item 54's Benchmark cosmetics (caption wrap; default anchor). *– addressed this already in the benchmark sections*

**L3.** v1 extras not adopted: glossary tooltips on column headers, per-chart "how to read this" info panel, CSV export, click-to-highlight on charts, 🎲 Randomise. Adopt any? *– we need all of these, but can fix that next.*
