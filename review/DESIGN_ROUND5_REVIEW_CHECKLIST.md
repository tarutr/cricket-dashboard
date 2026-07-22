# Round 5 — owner review checklist (localhost:8000)

Everything built in Round 5, grouped by where you'll see it. Five of six waves built (per-over parked).
Numbers were held sacred throughout — the standing anchors reproduce exactly and I DuckDB-verified every
number-adjacent change independently. Suggested scope to load: **Men / T20 / International, 01/07/2023 →
02/07/2026** (the baseline: 2,813 players, Karanbir Singh 2,454, SA Yadav 60·1,544·29.13·150.34).

## Stats table & toolbar
- [x] **No note text under the toolbar** (the old "Matchup mode / N of M conditions" line is gone). *(#1)*
- [ ] Switch **Vs → Spin** and press Search: the rows **keep their positions**, only the numbers change
      (they don't reshuffle). *(#4)*
- [x] After that, **click the RUNS column header**: now it re-ranks — and the little sort arrow (▼) appears.
      Confirm the arrow shows **only** on a column that's actually sorting. *(#4 + your arrow ruling, decision 52)*
- [x] **Pin column** (left of the "#"): click a player's pin — they float to the top with a solid-red pin,
      keeping their real rank number; click again to send them back. *(#3/#12)*
- [x] Pin someone, then change Vs/preset (toolbar) → pin **stays**; open Filters and press its Search →
      pins **reset**. *(#3)*
- [x] Type a player in the results search and pick them → they **float to the top** like a pin. *(#2)*
- [x] A pinned player with no data in the current view shows **"–"** across their cells. *(#3/#11)*

## Filters popup
- [x] Open Filters, add a condition / change a team / change a date → **nothing** on the table or pills
      changes until you press the popup's **Search**. *(#9)*
- [x] "**+ Add condition**" list: "**Matchup (Vs)**" is the first item under *Advanced metrics* (just above
      "Dot Ball %"); "**Batting position**" is its own entry, and picking Vs=Spin no longer sprouts a second
      position dropdown. *(#5/#8)*
- [ ] Number conditions are **per discipline**: add a batting condition, switch to Bowling → it's gone; switch
      back → it's there. Your player filters (role/hand/style/teams) survive the switch. *(#7)*
- [x] "**Keep Selected Columns**" is greyed on a blank table and after a discipline switch. *(#10)*
- [ ] Filter on a metric (e.g. Best Bowling ≥3 for ≤20) and Search → that column **auto-appears** and the
      table ranks by it. *(#6)*
- [x] **Domestic opposition** now works: Team Type → Domestic, add "Against opposition" (no longer greyed),
      pick a club → results narrow. *(#14)*

## Graphs
- [ ] **Runs per Innings** is gone everywhere; **Best Bowling** is gone from the graph metric pickers (still a
      table column + filter). *(#20/#22)*
- [ ] No metric label reads "(Innings)" in a T20 scope where the Filters drawer doesn't. *(#23)*
- [ ] Reset link reads "**Reset to full player set**", greys when the roster is already full, boxed with the
      "N of N selected" dropdown. *(#13)*
- [ ] Pick a chart type with no metric → the empty box shows a red "needs input" outline + guidance. *(#19)*
      *(On a brand-new Graphs tab the chart-type box shows this immediately — tell me if you'd rather hold it
      until the first "Update chart".)*
- [ ] **Scatter**: the X dropdown won't offer the metric currently on Y (and vice-versa).
- [ ] **LINE (the big one)**: chart type Line → two dropdowns, **X axis** + **Metric**. Try X = Date—year
      (a trajectory), X = Opposition or Match result (a profile), X = Phase. Up to **6** players; a player with
      one bucket shows a single point with a footnote; no faded points. *(#21 / decision 53)*

## Player popup
- [ ] Open a player → **Player Filters**: the drawer is tidier/denser (date on one row, position + Vs paired,
      narrower panel). *(#16)*

## Not in this round (parked — see BACKLOG.md)
- Per-over Line axis; the Tier 2–4 load-speed work; the #18 coverage note decision; team-name normalization.
