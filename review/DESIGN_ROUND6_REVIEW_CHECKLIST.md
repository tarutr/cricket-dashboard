# Round 6 — owner review checklist (localhost:8000)

The 12 items from your Round-5 hands-on review. All built + orchestrator-verified; numbers held sacred
(query builders + metric formulas byte-identical across the whole round — anchors reproduce exactly).
Suggested scope to load: **Men / T20 / International, 01/07/2023 → 02/07/2026** (baseline 2,813 / Karanbir 2,454).

## Bugs (now fixed)
- [x] **#5 / #10 — Graphs filter popup.** Open Graphs → Filters, flip Batting/Bowling → the popup's controls
      rebuild **live**; nothing changes the chart (or your Stats scope) until **"Apply to graph"**. No more
      batting-metric-on-bowling-data breakage.
- [x] **#3 — Best Bowling filter** now ranks the table by the **BBI figure** (wickets desc, then runs asc:
      5-25 > 4-20 > 4-25), not raw wickets.
- [x] **#6 — "Reset to full player set"** returns the correct set for the committed discipline.
- [x] **#1 — fine Vs re-sort:** closed — the code can't make coarse/fine differ; what you saw was a stale
      browser cache. (If you ever see it again, hard-refresh `Cmd+Shift+R`.)
- [x] **#4 — "Average (vs style)"** is renamed to plain **"Batting Average" / "Bowling Average"** (it was
      always just the Vs-mode average, labelled confusingly).

## Chartability (#9)
- [x] In Graphs, each player row in the roster dropdown shows a green **CHARTABLE** / red **NOT CHARTABLE**
      pill for the current chart type.
- [x] A Line in a scope where no one has 2+ points shows a plain-English **"can't draw a line / try a wider
      range"** message instead of a field of stray dots.

## Features
- [x] **#2 — "Batting hand"** no longer appears as a filter in **Bowling**, and no longer carries across the
      Batting↔Bowling toggle. (Bowling style stays a batting filter — that's the intentional "how leg-spinners bat".)
- [x] **#7 — chart type "Phases" renamed to "Grouped Bars"** (behaviour unchanged for now; the "any metric"
      rebuild is a later item).
- [x] **#8 — Line X=Phase** now also offers **Runs / Balls** (batting) and **Runs Conceded / Balls / Bowling SR
      / Bowling Average** (bowling), on top of the existing Strike Rate / Economy / Wickets. **← see the one
      decision below.**
- [x] **#11 — player popup:** the Vs-opposition table is capped to the left column's height with **Show
      more / Show less**.
- [x] **#12 — Stats table:** after "Show more (X players)", a **"Show top 50"** button collapses back to the top 50.

## One decision for you (from #8)
On the **plain bowling** X=Phase view, the *new* metrics show **Powerplay + Middle + Death**, but the older
**Economy / Wickets** show only **Powerplay + Death** (the middle-overs bucket was never catalogued for plain
bowling, though the data exists). Options: **(a)** add the Middle bucket to Economy/Wickets so all phase lines
are consistent (my lean — matches "show all data"); **(b)** leave it. Tell me which.

## Not in this round (parked — see BACKLOG.md)
- #18 coverage note (decide: build a new one?); #19 fresh-load red outline (keep or hold?); the fuller phase
  metrics + per-over (the components/lazy-load data-layer project); Tier 2–4 load speed; team-name normalization.
