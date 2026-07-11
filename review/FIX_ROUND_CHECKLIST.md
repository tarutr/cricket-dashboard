# Fix round — owner verification checklist

Everything you asked for in review/design_round_2_decisions.md, built and verified on
`polish-b1-mechanical` (7 commits, 6de0ef9 → 72d8533). Review on localhost:8000 —
hard-refresh first (Shift+reload). Reply with item numbers + verdicts; **[FLAG]**
items are judgment calls I made that deserve your explicit yes/no.

## A · Stats page
1. Graph + Columns now truly flush right in the toolbar.
2. Averages mute below **5** dismissals (your CM Carroll 98.75 case now renders
   muted with "Based on 4 dismissals"); other dismissal stats still mute below 3;
   the Benchmark chart's footer reports the same floors honestly.
3. The "may be excluded by your current filters" toast fires (kohli + Runs ≥ 5000).
4. Pressing Enter right after typing in a search box works (was silently swallowed).

## B · Filter drawer
5. Sections: Team → Player profile (Role · Batting hand · **R. Pos.** · Bowling
   style) → Advanced (Against (opposition) · Stat conditions). Innings section gone.
6. Team is a dual control: **Current team | Historic team** + team picker. Pills read
   "Team: India" vs "Ever played for: India". **[FLAG]** Switching mode clears the
   other mode's pick, so only one team filter is active at a time — flip if you want
   both at once.
7. **R. Pos.** filters by a player's most common batting position *within the current
   scope* (ties go to the lower number), with hover text. Verified independently
   against the raw database: R. Pos. = 3 → 282 players; SA Yadav (regular position
   4: 34 innings at 4, 22 at 3) is correctly excluded.
8. Women view: Role/Batting hand/Bowling style and Historic team are **removed**
   (not greyed — all four come from the men-only profiles sheet); the disclaimer
   stays; Team and R. Pos. work for women (R. Pos. = 3 → 177 players).

## C · Player popup
9. Left column: By batting position → **Wicket Type** → **Progressive Scoring**
   (both renamed); right column: Vs opposition capped ("Top 8 of 14 opponents by
   innings") so the columns balance.
10. With a Vs filter on, the can't-split sections disappear entirely (no grey
    boxes). "Wicket Type — bowler-credited vs Spin" keeps the honest label.
11. **[FLAG]** Under a Vs filter, Matchups now shows the FULL Pace/Spin/type
    breakdown instead of a refusal — the row for your selected type matches the
    headline tiles exactly, so it reads as "your slice in context". Confirm you
    like this.
12. Popup collapses to one column below ~900px; no sideways clipping at any width.

## D · Graphs
13. No auto-filled graphs anywhere. No search run → "Run a search on the Stats tab
    first." (and no query runs). Search run → "Pick a chart type to get started."
    with your results as the pool (15 candidates).
14. Greyed chart types are clickable and explain themselves in a sentence in the
    chart area (why + what to do). Root cause of your dumbbell frustration found:
    the tiles were real disabled buttons — dead to clicks.
15. **Dumbbell works directly**: Men + Batting results → click Dumbbell → Side A/B
    (Pace vs Spin) renders. No matchup detour needed.
16. Your choices persist — type, metric, roster, toggles survive tab switches and
    type changes; scope changes explain instead of silently switching your chart.
17. "Graph this player" opens a chooser (type + metric) first, then lands on a
    rendering chart. At a full chart the new player replaces the last one, with a
    note.
18. The auto "top-15 bar" bridge and "← Back to your table" link are gone; tab
    switches still preserve your table.
19. Slope lines carry "Name (value)" at BOTH ends; Benchmark's 100% line is one
    unbroken vertical; radar is 3-per-row; picker captions deleted; "By year" is
    now "Line"; tile labels never clip.

## E · Table
20. Sticky name column much thinner (160px desktop, narrower on tablet/phone),
    long names ellipsized with the full name on hover.
21. Drag column headers left/right to reorder (mouse; on touch the table still
    scrolls normally). Reordering never re-queries.
22. Search split: the **header** search (next to the tabs, both views) opens player
    popups; the **table** search adds players to your results with a removable
    "+ Name" pill — even players your filters exclude (pinned SA Yadav under
    Runs ≥ 5000 shows his exact real numbers). A player with no innings in scope
    gets a toast, not a broken row. Pins are inert in matchup mode (greyed pill).

## F · Mobile (~375px)
23. New scope strip: Gender/Discipline as big paired toggles, Format/Team type side
    by side, Date range and All filters full-width. ~34% of the screen, works to
    320px. (Alternative if you dislike it: a one-line "Men · Batting · T20 …"
    summary that expands on tap — say the word.)
24. Charts render at ONE fixed desktop size (860px) and you swipe sideways INSIDE
    the chart box; the page itself never scrolls sideways. **Export/Copy PNG now
    equals what you compose on the phone** — verified the capture is the full
    desktop-shaped card (918px wide) from a 375px screen.
25. Table search is full-width with a "Search a player" caption; header search
    collapses to an icon.

## G · Bugs found and fixed along the way (invisible but real)
26. Removing two pills quickly could paint a stale empty table over the "Choose
    your filters" prompt — fixed; almost certainly the "table went empty on its
    own" moment from the July review.
27. In bowling matchup mode with a position filter, several chart types crashed on
    a missing column — latent for months, unreachable until tiles became clickable;
    fixed.
28. Anchors re-verified after every query-touching change: baselines 2,813/2,049;
    SA Yadav 60/1,544/29.13/150.34 (career), 38/454/140.99 + "913 of 1,027 balls"
    (vs Spin), 22/551 (pos 3); Bumrah vs RHB at 1–2 = 27/177/9. R. Pos. numbers
    were derived independently from raw R2 with different SQL before trusting the
    app.

## After your verdicts
Your call on the merge gate to main. Then, in order: the five v1 extras you wanted
(glossary tooltips, per-chart how-to, CSV export, click-to-highlight, Randomise) →
feedback form (Supabase) → performance audit → file splits.
