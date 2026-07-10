# cricdb — Chart System Reference (for brand-kit / asset work)

Everything a design session needs to create assets for the Graph Builder's chart
types: exact palettes, typography, card anatomy, per-chart layouts, every control and
annotation, the honesty rules that constrain copy, all states, and the features that
are planned but NOT yet built (marked ⏳ throughout). Written 2026-07-10 against
branch `polish-b1-mechanical` (decisions 42–45 in `review/owner_decisions.md`).

---

## 1 · Design foundations

### 1.1 The Paper Card concept
Every chart renders inside a **paper card** — an exportable "printed artifact".
It uses a **fixed light palette regardless of the app's theme** (the app has
light/dark tokens; the card never changes, so exported PNGs always look identical).
Assets should treat the card as a standalone printed object.

### 1.2 Fixed paper palette (the card's world)
| Role | Hex |
|---|---|
| Card background | `#ffffff` |
| Chart-area panel | `#f2ede1` |
| Ink (text, default bars/lines) | `#1b2430` |
| Accent (highlights, "beaten"/fell) | `#9c2b2b` |
| Good (improved/rose) | `#2f6b3f` |
| Muted (secondary text, faded marks) | `#6b6f76` |
| Rules/gridlines | `#ded7c8` |

### 1.3 Series palette (multi-player charts: scatter, donut, by-year, phases)
Ten qualitative colors, in order:
`#9c2b2b` `#2f6b3f` `#3a5a9c` `#b8842f` `#6b4a9c` `#2f8a8a` `#9c2f6b` `#5a7a2f` `#2f4a9c` `#9c6b2f`

### 1.4 App-frame palette (context around the card — NOT the card)
Light: bg `#faf8f4`, raised `#ffffff`, fg `#1b2430`, muted `#6b6f76`, line `#ded7c8`,
panel `#f2ede1`, accent `#9c2b2b`, good `#2f6b3f`, active bg/fg `#1b2430`/`#faf8f4`.
Dark (tokens exist; ⏳ no user-facing toggle yet): bg `#14181f`, raised `#1b212b`,
fg `#ece6da`, muted `#9a9fa8`, line `#333a46`, accent `#e2735a`, good `#5fa876`.

### 1.5 Typography
- **Display: Bricolage Grotesque** (variable, self-hosted) — card titles, app
  headings, stat-tile numbers, the lowercase "cricdb" wordmark.
- **Body: Inter** (variable, self-hosted) — everything else.
- Card title ≈ 27–34px bold display; eyebrow = small caps Inter with letter-spacing;
  subtitle/footer = Inter, footer italic; small-text scale tokens: 0.72 / 0.78 /
  0.8 / 0.85rem.
- Numbers use `font-variant-numeric: tabular-nums` wherever they align in columns.

### 1.6 Card anatomy (top to bottom)
1. **Eyebrow** — `CRICDB · BATTING` or `CRICDB · BOWLING` (small caps, muted).
2. **Title** — auto-generated, HONEST (see §2.3), contenteditable: hover shows a
   ✎ pencil + "Click to edit". A user-edited title survives roster changes but is
   regenerated when chart type/metric changes.
3. **Subtitle** — the scope sentence (e.g. "Men's T20s (international), Jul 2023 –
   Jul 2026, Runs ≥ 300"), also editable; regenerates on any parameter change.
4. **Chart area** — cream panel `#f2ede1`; Chart.js canvas OR laid-out DOM
   (radar small-multiples and Benchmark are DOM/mini-canvases).
5. **Footer** — left: the honest scope line, italic, NEVER editable (it must always
   state the real applied filters; slope/dumbbell/benchmark append their extra
   windows/sides/floors here). Right: the `cricdb` watermark.
6. **Actions below the card** — `Export PNG` (html2canvas, scale 2, filename
   `cricdb-<slugified-title>.png`, button shows "Exporting…" disabled state) and
   `Copy PNG` (clipboard; hidden on unsupported browsers).
   ⏳ Not built: square/16:9 social-size export presets.

---

## 2 · Shared systems (apply to every chart)

### 2.1 Chart-type picker
Nine tiles in a 3-per-row segmented grid, each with a one-line muted **caption**
(exact strings in §3). One tile carries a small **"Recommended"** tag (best fit for
the current metric/player state). Types that don't fit grey out with a REASON in
their tooltip (e.g. "Batting view only for now.", gender gates, needs-N-players).

### 2.2 Roster model (the owner's v1 pattern)
- Two lists: **candidates** (the pool — never truncated by anything) and
  **checked** (what's plotted), managed in a dropdown button reading
  **"N of M selected"** → checkbox rows, each row: checkbox + name + pool rank
  (#1…) + an × (remove from pool).
- At a chart's cap, unchecked rows disable with tooltip
  *"Max N for this chart type — untick one first."* Nothing is ever silently dropped.
- When pool > cap: a **Manual | Best | Worst** segmented control; Best/Worst
  auto-check the top/bottom N by the chart's ranking metric; any manual tick
  freezes the mode to Manual.
- Add via the "Add a player…" search; "Reset to filtered set" reseeds from the
  current leaderboard.

### 2.3 Honest-title grammar (SPEC §8.4 — copy constraint for all assets)
Titles may only claim what is actually drawn:
- Clean seed ranked by the displayed metric → `Runs — top 15`
- Clean seed ranked by a different stat → `Runs — top 15 by batting average`
- Manually edited roster OR any player excluded → `Runs — 14 players`
- Per-type prefixes: slope `Strike Rate — Jul 2023–Jan 2025 vs Feb 2025–Jul 2026 — …`,
  by-year `Strike Rate by year — …`, dumbbell `Strike Rate — vs Pace vs Spin — …`,
  benchmark `<Anchor name> vs the field` (no count phrase),
  scatter `Batting Average vs Strike Rate` (no count claim).

### 2.4 Honesty annotations (recurring visual elements to design for)
- **Exclusion note** under the sidebar: `Excluded (no data): <names>` and per-type
  qualification notes ("11 of 12 selected players have innings in both windows.").
- **Coverage lines** wherever bowling-style data is involved: `Style data covers
  913 of 1,027 balls faced (88.9%).`
- **Faded/muted marks** = "true but thin sample" (never hidden): by-year points
  under 30 balls; muted table values with tooltip `Based on N balls/dismissals`.
- **Cap note**: `This chart type caps this chart at N players — M not shown here —
  they'll come back when you switch to a larger chart type.`
- **Em-dash `—`** = no data (never rendered as 0 for rates).

### 2.5 States every chart can be in
1. Normal. 2. **Below-minimum placeholder** — card shows only
   "Add at least N players to draw this chart." (title regenerates honestly, canvas
   hidden). 3. **Loading** — muted status line. 4. **Error** — shared error box +
   Retry. 5. **Disabled tile** (see §2.1 reasons; women's matchup data doesn't
   exist → dumbbell/Vs greyed with "No bowling-style data for women's cricket yet").

### 2.6 Mobile (375px verified)
No page-level horizontal scroll for any type. Sidebar controls become stacked
full-width dropdowns. Value labels auto-drop when dense (per-type rules below).

---

## 3 · The nine chart types

### 3.1 BAR — "Rank players on one stat"
- Players 2–15 · one metric, any kind (total/rate/percent).
- Horizontal bars, **leader at top**, ink bars with the **leader's bar in accent
  red**; value labels at bar ends, drawn INSIDE the bar (white on fill) when they'd
  clip the right edge; every player labelled at every width (no tick skipping).
- **Style toggle: Bars ⇄ Dots** — lollipop variant: thin line + endpoint dot, same
  data. (Asset note: two visual variants of the same chart.)
- Max variability: 2–15 rows; label lengths from "S Dube" to
  "K Kadowaki-Fleming"/"United States of America"-scale names; values 1–5 digits
  with thousands separators.

### 3.2 DONUT — "Share of a total — needs a countable stat"
- Players 2–20 checked · one metric, **totals only** (runs, wickets, sixes…).
- Renders **top 7 slices + one "Other (N players)"** aggregate slice → 3–8 slices
  ever visible. Series palette in order; legend right with name + value + %.
- States: additive-only metric select (rates never offered).

### 3.3 SCATTER — "Two stats mapped against each other"
- Players 5–60 · two metrics (X and Y axis selects, must differ).
- Points in accent red, name labels beside points (clamped inside the plot; flip to
  the left at the right edge); **dashed median guide-lines** on X and Y forming
  quadrants (muted ink, dashed).
- ⏳ Not built: click-a-dot to highlight (dim rest), editable quadrant-corner
  labels, trend line — all existed in the owner's v1; candidates for adoption.

### 3.4 RADAR — "Player shape profiles, side by side"
- Players 1–6 · a **curated metric GROUP** (not free pick): batting Reliability
  (avg, balls/dismissal, runs/inn), Scoring shape (SR, boundary %, dot %), Impact
  (T20), Phase mastery (T20/ODI); bowling Wicket-taking, Control, Phase mastery.
- **Small multiples**: one mini-radar per player in a 3×2 grid (2-col → 1-col on
  mobile), all sharing per-metric normalisation against the selected players' max;
  player name under each mini; single accent color (deliberately not rainbow);
  NO overlaid webs (owner ruling).

### 3.5 PHASES — "One stat across match phases, side by side"
- Players 2–8 · one metric FAMILY (fixed 2–3 members):
  batting "Phase strike rate (T20: PP · middle · death)" and "Innings build-up SR
  (balls 1–10 · 11–20 · 21+)"; bowling "Phase economy (T20: PP · death)" —
  honestly 2-phase (no middle-economy metric exists).
- Grouped vertical bars: x = players, one bar per phase, phases in chronological
  order, first three series colors (red/green/blue); legend on top.
- Family availability is format-gated (T20 families only under a pure-T20 scope).

### 3.6 SLOPE — "One stat, two date windows — who rose, who fell"
- Players 2–12 · one **rate or percent** metric · **two explicit month-range
  pickers** ("Window A", "Window B"; default = first/second half of the current
  scope; overlap allowed).
- Two category columns, one line per player; **color = IMPROVEMENT**, not raw
  direction: green `#2f6b3f` improved, red `#9c2b2b` declined (economy falling =
  green), muted flat. Names right-endpoint only with 12px vertical collision
  nudging; value labels at both endpoints only when ≤8 players are drawn.
- Both windows stated in title, subtitle AND footer. Players missing either window
  are dropped and named ("N of M selected players have innings in both windows.").

### 3.7 BY YEAR — "One stat, year by year"
- Players 1–6 · one metric of kind **total, rate, or percent** (innings-sourced).
- Line chart, x = calendar years in scope, series palette per player;
  **missing year = gap** (spanGaps off, never a fake zero); a year with under
  **30 balls** draws **faded/hollow** with footnote *"Faded points: under 30 balls
  that year."*; tooltips carry the sample ("SR 152.0 · 571 balls").
- ⏳ Not built: monthly granularity; rolling averages.

### 3.8 DUMBBELL — "One stat, two bowling types — the gap is the story"
- Players 2–12 · one **matchup-namespace** rate/percent metric · two scope selects
  **Side A / Side B** (default Pace vs Spin; any fine bowling type offerable:
  Off-spin, Leg-spin, Slow left-arm orthodox, Left-arm wrist-spin, Slow-medium,
  Medium, Medium-fast, Fast-medium, Fast).
- Horizontal rows sorted by Side-B value: muted connector line, **Side A = hollow
  ink dot, Side B = filled accent dot**, dynamic legend "○ vs Pace · ● vs Spin";
  value labels with the slope's declutter rules; per-side coverage in tooltips
  ("vs Spin: 913 of 1,027 balls").
- **Batting + Men only** (matchup data is men-only; honest disables elsewhere).
- Entry point: the Stats table in matchup mode → "Graph" lands here with Side B
  pre-set to the table's Vs pick.

### 3.9 BENCHMARK — "One player against the best of the rest, stat by stat"
(The owner's dominance chart, from `image_inspiration/graph_example.png`.)
- **Anchor select** (from checked roster) + **Metrics…** multi-select (4–12,
  grouped by kind under headers **Volume** (totals) / **Tempo** (rates) /
  **Consistency** (percents)). Pool = EVERYONE passing the current filters, not
  just the roster.
- Per metric row: horizontal bar from 0 to (best other ÷ anchor)×100, visually
  capped ~115% with "(off scale)" overflow label; caption in the bar zone:
  `#2 Waseem Muhammad · 80.6% of Karanbir Singh` when the anchor leads (ink bar),
  flipping to **accent red + `#1 <name>`** when the anchor is beaten. Right-hand
  columns: the anchor's raw value + the anchor's pool rank (`#1`, `#4`).
- A vertical **anchor = 100% reference line** with a label.
- Lower-is-better metrics are direction-normalised so ≤100% always means "anchor
  leads". Rate/percent rows exclude sub-floor players from the ranking (floors
  stated in subtitle+footer: "rates/percents: min 30 balls, min 3 dismissals");
  the anchor itself is never excluded — it mutes instead.
- DOM-rendered (not canvas) — exports fine.
- ⏳ Open cosmetics (owner rulings pending): the "(off scale)" caption should wrap
  at 375px; default anchor may change to the seed-metric leader.

---

## 4 · Caps summary table

| Type | Players min–max | Metrics | Notes |
|---|---|---|---|
| Bar | 2–15 | 1, any kind | Bars/Dots toggle |
| Donut | 2–20 | 1, totals only | renders ≤8 slices (top7+Other) |
| Scatter | 5–60 | 2, any | |
| Radar | 1–6 | group of 3 | small multiples |
| Phases | 2–8 | family of 2–3 | format-gated |
| Slope | 2–12 | 1, rate/percent | two date windows |
| By year | 1–6 | 1, total/rate/percent | 30-ball fade floor |
| Dumbbell | 2–12 | 1, matchup rate/percent | batting+men only |
| Benchmark | anchor from roster | 4–12, kind-grouped | pool = whole filtered set |

---

## 5 · Not yet built (design ahead for these) ⏳

From the owner's v1 dashboard, approved-in-principle candidates awaiting a ruling:
1. **Glossary tooltips** on every column/metric name (hover explains the stat).
2. **"How to read this chart"** info panel — a paragraph per chart type.
3. **CSV export** mirroring the on-screen table.
4. **Click-to-highlight** on bars/dots/slices/minis (highlight one player, dim
   the rest to ~16% opacity — v1 behavior).
5. **🎲 Randomise** — archetype-driven random chart generator.
Plus known future items: app dark-mode toggle (tokens ready; the paper card stays
light by design), social-size export presets, monthly granularity for By-year,
team/venue popups, headshot use beyond the player popup (1,360 real headshot URLs
exist in the data with a designed monogram-medallion fallback).

---

## 6 · Asset-making guardrails (the non-negotiables)
- The footer scope line is sacred: never design a card without room for one-to-three
  lines of honest italic scope text + the watermark.
- Every "N of M" / coverage / faded / excluded device above is a REQUIRED part of
  the visual language, not decoration — assets should show them, not crop them.
- No metric value may be invented in marketing assets that contradicts the anchors:
  SA Yadav (T20I, Jul 2023–Jul 2026) 60 inns/1,544 runs/avg 29.13/SR 150.34; vs
  Spin 38 inns/454 runs/SR 140.99 with 913 of 1,027 coverage; Karanbir Singh 2,454
  runs with Waseem Muhammad at 80.6% — these are real, verified numbers safe to use
  in mockups.
- Charts render in the fixed paper palette even if the app around them is dark.
