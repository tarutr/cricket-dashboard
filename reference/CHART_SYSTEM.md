# cricdb — Chart System Reference (functional spec for brand-kit / asset work)

Everything the brand-kit session needs about how the Graph Builder's charts WORK:
structure, controls, annotations, states, copy rules, and variability ranges.
**Deliberately contains no aesthetic prescriptions** — no colors, typefaces, sizes or
spacing. Those are the brand kit's job. Where the charts need a visual distinction to
function, this doc names the SEMANTIC SLOT the brand kit must fill (e.g. "an
improved/declined pair") and states the functional constraint on it.
Written 2026-07-10 against branch `polish-b1-mechanical` (decisions 42–45 in
`review/owner_decisions.md`).

---

## 1 · Functional constraints the brand system must satisfy

### 1.1 The exportable card
Every chart lives inside a **card** that users export as a PNG (and copy to
clipboard) for publishing/social. Functional requirements:
- The exported card must render **identically regardless of the app's theme** —
  it is a standalone artifact. (Currently implemented as a fixed light card; the
  brand kit may re-specify its look, but "one consistent export look" is the rule.)
- Export is a DOM snapshot at 2× scale — anything designed must rasterise cleanly
  (no effects that html2canvas can't capture: prefer solid fills/borders over
  exotic filters).

### 1.2 Semantic color slots (brand kit to define; functions fixed)
| Slot | Function | Constraint |
|---|---|---|
| Default mark | bars/lines/dots when nothing special | must contrast on the chart-area surface |
| Emphasis | the leader's bar; the anchor/highlighted player | instantly distinguishable from Default |
| Improved | slope lines that got better; benchmark "anchor leads" is Default | universally reads "good" |
| Declined / Beaten | slope lines that got worse; benchmark rows where the anchor is beaten | universally reads "bad"; pairs with Improved |
| Muted / Faded | thin-sample marks, secondary text, disabled states | reads "true but weak", not "error" |
| Series ramp | ≥10 mutually distinguishable colors for multi-player charts (scatter, donut, by-year, phases) | order matters (assigned by roster order); adjacent pairs must stay distinct in a 12px legend swatch |
| Rules/grid | axes, gridlines, connectors | recede behind marks |
- The improved/declined pair is **direction-aware by meaning, not by number**: a
  bowler's economy going DOWN renders as Improved. Assets must never hard-couple
  "up = good".
- Dumbbell additionally needs a **shape** distinction (currently hollow dot =
  Side A, filled dot = Side B) that survives monochrome printing.

### 1.3 Typography slots
- A **display role** (card titles, big stat-tile numbers, wordmark) and a **body
  role** (everything else). Numbers that align in columns require tabular figures.
- Longest strings the system must set without breaking (test assets against these):
  player "K Kadowaki-Fleming", team "United States of America", title
  "Strike Rate — Jul 2023–Jan 2025 vs Feb 2025–Jul 2026 — 11 players", metric
  "Out Obstructing the Field %", family "Phase strike rate (T20: PP · middle · death)".

---

## 2 · Card anatomy (structural, top to bottom)

1. **Eyebrow** — `CRICDB · BATTING` / `CRICDB · BOWLING` (discipline marker).
2. **Title** — auto-generated and HONEST (grammar in §3.3), user-editable in place:
   an edit affordance appears on hover ("Click to edit"); an edited title survives
   roster changes but regenerates when chart type/metric changes.
3. **Subtitle** — the scope sentence ("Men's T20s (international), Jul 2023 – Jul
   2026, Runs ≥ 300"), also editable, regenerates on any parameter change.
4. **Chart area** — a visually distinct panel; content is a canvas chart OR laid-out
   DOM (radar small-multiples and Benchmark are DOM grids — design must work for both).
5. **Footer** — left: the honest scope line, NEVER editable (it must always state
   the real applied filters; slope/dumbbell/benchmark append their windows/sides/
   sample floors here — allow up to ~3 lines). Right: a brand watermark slot.
6. **Actions under the card** — `Export PNG` (with an in-progress disabled state:
   label becomes "Exporting…") and `Copy PNG` (hidden if the browser can't).

---

## 3 · Shared systems (all charts)

### 3.1 Chart-type picker
Nine types, each with a one-line **caption** (exact copy in §4). One tile carries a
**"Recommended"** tag (computed best fit for the current state). Types that don't
fit the current state render disabled with a reason available on hover (e.g.
"Batting view only for now.", "No bowling-style data for women's cricket yet",
needs-more-players). Design needs: enabled / disabled-with-reason / recommended /
active states for a 9-item picker that also works at ~375px.

### 3.2 Roster control
- Two-list model: a **pool** of candidates (never truncated) and a **checked**
  subset (what's plotted). UI: a dropdown button labelled `N of M selected` opening
  checkbox rows — each row: checkbox, player name, pool rank (`#1`…), and a remove
  control (removes from pool entirely).
- At a chart's player cap, unchecked rows disable with tooltip
  *"Max N for this chart type — untick one first."* Players are NEVER silently
  dropped; switching to a bigger chart type restores them.
- When pool > cap: a three-way **Manual | Best | Worst** control (Best/Worst
  auto-pick top/bottom N by the chart's ranking metric; any manual tick flips the
  mode to Manual).
- Plus: a player-search add box, and "Reset to filtered set".

### 3.3 Honest-title grammar (hard copy rule — SPEC §8.4)
Titles may only claim what is actually drawn:
- Clean seed, ranked by the displayed metric → `Runs — top 15`
- Clean seed, ranked by a different stat → `Runs — top 15 by batting average`
- Roster manually edited, or anyone excluded → `Runs — 14 players`
- Type-specific frames: slope `Strike Rate — <Window A> vs <Window B> — …`;
  by-year `Strike Rate by year — …`; dumbbell `Strike Rate — vs Pace vs Spin — …`;
  benchmark `<Anchor name> vs the field` (no count phrase); scatter
  `Batting Average vs Strike Rate` (no count claim).

### 3.4 Honesty annotations (required visual devices, not decoration)
- **Exclusion notes**: `Excluded (no data): <names>` + per-type qualification lines
  ("11 of 12 selected players have innings in both windows.").
- **Coverage lines** wherever bowling-style data appears:
  `Style data covers 913 of 1,027 balls faced (88.9%).`
- **Faded marks** = real but thin sample (by-year points under 30 balls; footnote
  "Faded points: under 30 balls that year."). Faded ≠ hidden, ever.
- **Cap note**: `This chart type caps this chart at N players — M not shown here —
  they'll come back when you switch to a larger chart type.`
- **Em-dash `—`** = no data. Rates are never rendered as 0 when there's no sample.

### 3.5 States every chart can occupy
1. Normal. 2. **Below-minimum placeholder** — the card renders with only
"Add at least N players to draw this chart." (title still regenerates honestly).
3. **Loading** — quiet status line. 4. **Error** — shared error box + Retry.
5. **Disabled type** (§3.1). Assets should exist for at least 1, 2 and 5.

### 3.6 Mobile (~375px, verified)
No page-level horizontal scroll for any type. Dense-label charts drop their value
labels automatically (rules per type below). Sidebar controls become stacked
full-width; the roster dropdown must fit `min(20rem, 100vw − 2rem)`.

---

## 4 · The nine chart types (function, controls, annotations, variability)

### 4.1 BAR — caption: "Rank players on one stat"
- Players 2–15 · 1 metric (any kind: total/rate/percent).
- Horizontal bars, **leader at the top**; the leader's bar takes the Emphasis slot.
- Value labels at bar ends; when a label would clip the chart edge it renders
  INSIDE the bar (needs an on-Emphasis text treatment). Every player is labelled at
  every width — no tick skipping.
- **Two visual variants** via a "Bars ⇄ Dots" toggle: solid bars, or lollipop
  (thin connector + endpoint dot). Both need brand treatment.
- Variability: 2–15 rows; values 1–5 digits with thousands separators.

### 4.2 DONUT — caption: "Share of a total — needs a countable stat"
- Players 2–20 checked · 1 metric, **totals only**.
- Renders **top 7 + one "Other (N players)"** slice → always 3–8 slices. Series
  ramp in roster order; legend shows name + value + share %. "Other" needs a
  visually secondary treatment.

### 4.3 SCATTER — caption: "Two stats mapped against each other"
- Players 5–60 · 2 metrics (X/Y selects, must differ).
- Point marks + name labels beside points (labels clamp inside the plot; flip sides
  at the right edge). **Dashed median guide-lines** on both axes create quadrants.
- ⏳ Planned (v1 heritage, not built): click-to-highlight a point (dim the rest),
  editable quadrant-corner labels, optional trend line.
- Variability: 5–60 points — design for dense mid-field overlap.

### 4.4 RADAR — caption: "Player shape profiles, side by side"
- Players 1–6 · one curated 3-metric GROUP (batting: Reliability / Scoring shape /
  Impact / Phase mastery; bowling: Wicket-taking / Control / Phase mastery).
- **Small multiples**: one mini-radar per player in a grid (3×2 → 2-col → 1-col),
  shared per-metric normalisation, name under each mini. Overlaid webs are
  explicitly banned (owner ruling). Single mark color (minis are separated by
  space, not hue) — brand kit may revisit but separation must stay legible.

### 4.5 PHASES — caption: "One stat across match phases, side by side"
- Players 2–8 · one metric FAMILY of 2–3 members: batting "Phase strike rate
  (T20: PP · middle · death)" / "Innings build-up SR (balls 1–10 · 11–20 · 21+)";
  bowling "Phase economy (T20: PP · death)" — honestly two-phase.
- Grouped vertical bars: x = players, one bar per phase in chronological order —
  needs 3 distinguishable series colors + a legend. Families are format-gated
  (T20-only families vanish outside a pure-T20 scope).

### 4.6 SLOPE — caption: "One stat, two date windows — who rose, who fell"
- Players 2–12 · 1 rate/percent metric · **two explicit month-range pickers**
  (Window A / Window B; default = the halves of the current scope; overlap legal).
- Two category columns, one line per player. **Line color = Improved/Declined
  slots (meaning-aware, §1.2), flat = Muted.** Player names at the right endpoint
  only, vertically collision-nudged (~12px min gap); endpoint value labels render
  only when ≤8 players are drawn.
- Both windows appear in title, subtitle and footer. Dropped players are named.

### 4.7 BY YEAR — caption: "One stat, year by year"
- Players 1–6 · 1 metric (total/rate/percent).
- Line chart by calendar year, series ramp per player. **Missing year = a gap in
  the line** (never a fake zero). Years under a 30-ball sample render in the
  Faded slot (e.g. hollow point) + footnote. Tooltips carry the sample size.
- ⏳ Planned: monthly granularity, rolling averages.

### 4.8 DUMBBELL — caption: "One stat, two bowling types — the gap is the story"
- Players 2–12 · 1 matchup rate/percent metric · **Side A / Side B** selects
  (default Pace vs Spin; fine types offerable: Off-spin, Leg-spin, Slow left-arm
  orthodox, Left-arm wrist-spin, Slow-medium, Medium, Medium-fast, Fast-medium,
  Fast).
- Horizontal rows sorted by Side-B value: a connector line between two dots —
  **Side A and Side B need a non-color-only distinction** (currently hollow vs
  filled) + a dynamic legend ("○ vs Pace · ● vs Spin"). Value labels follow the
  slope declutter rule. Tooltips carry per-side coverage ("vs Spin: 913 of 1,027
  balls").
- Available on Batting + Men only — elsewhere the tile is disabled with an honest
  reason. Reachable directly from the Stats table's matchup mode via "Graph".

### 4.9 BENCHMARK — caption: "One player against the best of the rest, stat by stat"
(Modelled on `image_inspiration/graph_example.png`.)
- Controls: **Anchor** select (from the checked roster) + **Metrics…** multi-select
  (4–12, grouped under kind headers **Volume** = totals / **Tempo** = rates /
  **Consistency** = percents). The comparison pool is EVERYONE passing the current
  filters, not just the roster.
- Per metric row: a horizontal bar from 0 to (best other player ÷ anchor)×100,
  visually capped ~115% with an "(off scale)" label; in-bar caption
  `#2 Waseem Muhammad · 80.6% of Karanbir Singh` while the anchor leads (Default
  slot), switching to the Declined/Beaten slot with `#1 <name> · 103.0% …` when the
  anchor is beaten. Right columns per row: the anchor's raw value + the anchor's
  pool rank (`#1`, `#4`).
- A vertical **anchor = 100% reference line** with a label.
- Lower-is-better metrics are direction-normalised so ≤100% always means "anchor
  leads". Rate/percent rankings exclude sub-floor players (floors declared in the
  subtitle + footer: "rates/percents: min 30 balls, min 3 dismissals"); the anchor
  itself never disappears — it renders in the Muted slot instead.
- DOM-rendered rows (not a canvas) — the most "editorial layout"-like chart;
  a strong brand-expression opportunity.
- ⏳ Pending owner rulings: wrap the "(off scale)" caption at 375px; possibly
  default the anchor to the seed-metric leader.

---

## 5 · Caps summary

| Type | Players min–max | Metrics | Special |
|---|---|---|---|
| Bar | 2–15 | 1, any kind | Bars/Dots variant |
| Donut | 2–20 | 1, totals only | always 3–8 slices (top7+Other) |
| Scatter | 5–60 | 2, any | quadrant medians |
| Radar | 1–6 | curated group of 3 | small multiples, no overlays |
| Phases | 2–8 | family of 2–3 | format-gated |
| Slope | 2–12 | 1, rate/percent | two explicit date windows |
| By year | 1–6 | 1, total/rate/percent | gap ≠ zero; 30-ball fade |
| Dumbbell | 2–12 | 1, matchup rate/percent | batting+men only; shape-coded sides |
| Benchmark | anchor + whole filtered pool | 4–12, kind-grouped | anchor = 100% line |

---

## 6 · Not yet built — design ahead ⏳
1. **Glossary tooltips** on every metric/column name.
2. **"How to read this chart"** info panel (a paragraph per type).
3. **CSV export** of the on-screen table.
4. **Click-to-highlight** on bars/dots/slices/minis (one player emphasised, the
   rest strongly de-emphasised).
5. **🎲 Randomise** — archetype-driven random chart generator.
6. App-frame dark mode (theme hooks exist; the exported card stays single-look
   per §1.1). 7. Social-size export presets (square / 16:9). 8. Team & venue
   popups. 9. Headshots beyond the player popup — the data has ~1,360 real player
   photo URLs plus a designed-fallback requirement (initials medallion) for
   everyone else; any asset using player imagery needs that fallback story.

---

## 7 · Guardrails for mockups
- Never crop or omit the honesty devices (§3.4) from assets — they are part of the
  product's identity.
- Use REAL verified numbers in mockups rather than invented ones. Safe, verified
  examples (men's T20 international, Jul 2023 – Jul 2026): SA Yadav 60 innings /
  1,544 runs / average 29.13 / SR 150.34; SA Yadav vs Spin 38 innings / 454 runs /
  SR 140.99 with coverage "913 of 1,027 balls"; Karanbir Singh 2,454 runs with
  Waseem Muhammad second at 80.6%; Sikandar Raza SR by year 150.15 / 149.86 /
  125.92 / 164.80 (2023–2026).
- The scope sentence under any mocked chart must plausibly match the numbers shown
  (honest-description rule is absolute in this product).
