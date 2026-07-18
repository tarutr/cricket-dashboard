# cricdb — Design Round 4 handoff #2 (mid-round continuation)

> **READ THIS FIRST, then `CLAUDE.md` (repo root) and `.orchestrator/ORCHESTRATION.md`.**
> You are continuing an in-flight, gated design round in a FRESH chat with no memory of the
> prior conversation. Everything needed to continue is here or in the files this points to.
> Run as the **Opus 4.8 orchestrator** (`/opus-orchestrator`): decompose, delegate to
> right-sized subagents (model+effort per spawn), verify every result yourself in-browser,
> commit per wave, and **STOP for the owner's go between waves**. The owner is **non-technical**
> — report in plain English, name the control and what changed, never raw diffs.

## The two supreme rules (full text in CLAUDE.md)
1. **Numbers are sacred.** You change only WHEN/HOW things display, never WHAT a query
   returns, unless the task explicitly authorizes a query change. Query builders —
   `buildQuery`/`buildMatchupQuery` (`src/table.js`), `buildScopeClauses` (`src/filters.js`) —
   stay byte-identical otherwise. If an anchor moves, you touched calc logic → revert.
2. **Owner decisions are law; take instructions literally.** Never narrow OR extend a request.
   Build exactly what was asked; flag adjacent ideas as questions, never silent additions.
   (This round has repeatedly burned on over/under-scoping — the owner will catch it.)

## Standing anchors — re-derive every wave (scope Men / T20[+IT20] / International, 2023-07-01→2026-07-02)
- Batting baseline **2,813 players**; top row Karanbir Singh **2,454** runs.
- SA Yadav **60 inns / 1,544 runs / 29.13 avg / 150.34 SR**.
- SA Yadav **vs Spin = 38 inns / 454 runs / SR 140.99** (coverage 913 of 1,027).
- Bumrah **vs RHB at striker positions 1,2 = 27 inns / 177 balls / 9 wkts**.
- Query fingerprint (djb2, standard all-filters plain state): plain query **3307620867 / len 1430**.
- **"T20" scope = match_type IN ('T20','IT20')** via `expandFormats` — a naive single-'T20'
  check reads 2,810, not 2,813.

## HOW TO VERIFY (harness gotchas — these cost hours if unknown)
- Serve on **localhost:8000** (`python3 -m http.server 8000`); R2 CORS allows only that host.
- After editing modules: `fetch(path,{cache:'reload'})` each changed file **then navigate/reload
  the page** — `import()` returns stale modules otherwise. If the browser pane reports 0×0
  viewport, resize to **1280×800**.
- The Stats table needs **BOTH a From and a To date** set before Search runs; **matchup mode
  needs a plain Search first**, then pick a Vs bucket.
- Number-adjacent verification = **independent hand-written DuckDB**
  (`import('/src/db.js').then(m=>m.query('SELECT …'))`), counts derived independently — never
  reuse the app's aggregation shape. Reserved word `out`/`rows` will error; alias them.
- Cheapest correctness guard: if a change doesn't touch `table.js`/`filters.js`/`state.js`,
  the anchors are byte-identical by construction — confirm via `git diff` and move on.

## Branch / commit state
Branch **`polish-b1-mechanical`** (main untouched; merging is a separate owner decision).
HEAD ≈ `6348533`. Work lands as `wip:` commits per unit; owner reviews on localhost.

---

## PART A — What is DONE this round (all committed, owner-approved unless noted)

1. **Wave 4a — instant vs waits + pills.** Sort / columns / drag / picking-a-player-from-search
   are INSTANT (row drops in, no Search light); Filters/Dates/Vs/preset stay PENDING; pills
   reflect pending; pins recoloured steel-blue; a pill's ×/+ is soft-delete-with-undo and
   **PENDING** (only *picking* a player is instant — the owner corrected an over-reach here).
2. **Wave 4b — Vs mode honors ALL filters.** R. Pos. and added players (pins) now carry into
   Vs mode (they used to silently drop). Pins routed through a shared exemption helper; a
   permanent parity guard (`pipeline/dev_test_vs_filter_parity.mjs`) fails if any filter isn't
   wired into the Vs query. R. Pos. is now **batting-only** (was leaking into plain bowling).
3. **Coverage-breakdown.** The single matchup "Coverage — N of M (X%)" column was replaced by
   three ordinary, sortable/draggable/toggleable columns: batting **Pace BF % / Spin BF % /
   Uncat %**, bowling **RHB % / LHB % / Uncat %** (sum to 100%, computed un-filtered by the Vs
   bucket, `vsTableOnly`). Popup coarse matchup tables gained an **Uncategorised** row + a
   right-most "% BF" column; all popup coverage lines renamed **"Matchup data covers…"**.
4. **Wave 4c — four new Vs stats** (opt-in columns in the Vs restricted picker, `vsTableOnly`,
   NOT default-on): matchup_batting `matches`, `runs_per_innings`, `high_score`;
   matchup_bowling `matches`, `best`. HS/Best Bowling use a two-step peak CTE (per match:innings
   → max/arg_max). Verified: SA Yadav HS vs Spin=47, Bumrah Best vs RHB="2-9".
5. **Polish batch**: multiselect checkbox restyled (thin tick, no red box); **format switch no
   longer wipes the Team filter** (removed a stray `teams:[]` in `filters.js`); player-popup
   header buttons renamed **"Player Filters"** and **"Player Graphs"**.

---

## PART B — The APPROVED, NOT-YET-BUILT work (this is your job). Owner approved this plan.

### Wave A — filter & condition fixes (Stats + Graph share `drawer.js`, so these land in BOTH)
1. **"Matchup (Vs)" rename + move to top of advanced filters.** The condition/type currently
   labelled "Vs" (`drawer.js` `SINGLETON_TYPES.vs`, injected after Innings) → rename to
   **"Matchup (Vs)"** and position it at the **top** of the "+ Add condition" advanced list.
   Applies to Stats AND Graph automatically (shared component).
2. **Best Bowling → TWO-box condition** (owner chose this over dropping it). The current plain
   `best` condition is BROKEN: a single box compiles to `"5-23" ≥ [number]` (comparing the
   display *string* to a number — meaningless/errors). Build a compound condition with **two
   inputs, "≥ [W] wickets for ≤ [R] runs"**, filtering best-innings **rank ≥ (W×1000 − R)** —
   one clean comparison, two labelled boxes. Fix it for **plain AND Vs** (a new condition input
   type). Best Bowling's rank = `wickets*1000 − runs_conceded` (mirrors plain `best`).
3. **High Score as a Vs condition** (single box — it IS a number, `MAX(per-innings runs vs
   bucket)`). Wire the matchup peak value into the matchup HAVING/final filter (the peak CTE
   value exists post-join; the condition path just needs to reference it). Currently blocked by
   `isMetricRemovedFromFilters` (`advanced.js`) + a guard in `conditionToHaving` (`table.js`).
4. **Format-aware "(Innings)" label.** "Best Bowling (Innings)" should drop "(Innings)" for
   T20/ODI/50-over (redundant — one innings per match); keep it only for multi-innings formats
   (Test/first-class, where a bowler bowls twice). Display-only, format-conditional label.

### Wave B — matchup-aware Graph (the big one; number-adjacent; do AFTER Wave A gate)
**Goal:** the Graph can chart Vs metrics (owner: "Vs Spin is just a filter — a bar chart of
runs vs Spin is the same runs number over spin deliveries"). This makes the Stats and Graph
filter popups genuinely identical AND functional, and is a real new feature (not a tweak).

**What's wired wrong today** (Stats & Graph already run the SAME `drawer.js`; every divergence
stems from ONE thing — the Graph wraps the store to force `matchupVs = null`, `graph.js`
~309-321):
- Graph's "+ Add condition" never offers matchup metrics (`effectiveNamespace` never resolves
  to a matchup namespace there).
- Graph's "Vs" control shows but is inert (never registers active, never disables after set).
- Matchup "Batting position" (striker) control permanently hidden in the Graph; a
  bowling-matchup position condition is never offered.
- **LIVE BUG:** setting Vs from inside the Graph popup writes to the real shared `matchupVs`
  and flips the **Stats table** into matchup mode while the Graph ignores it. Fix this.
- Separately: the Graph's charting layer is hard-wired to the plain namespace — `charts.js`
  `fetchSelectedPlayerMetrics` builds its OWN query over the plain batting/bowling view
  (`getMetric(k, discipline)`, plain view), and ~15 sites in `graph.js` use
  `eligibleMetrics(state.discipline,…)` / `getMetric(key, state.discipline)`. It never touches
  the matchup namespaces, so it couldn't PLOT a Vs metric even if the filter offered one.

**How to change it:**
1. Stop nulling `matchupVs` in the Graph store wrapper (`graph.js` ~309-312) → Vs control +
   matchup metrics go live in the Graph filter; the live bug disappears (Graph now shares the
   real Vs state honestly).
2. Point the Graph's ~15 metric-picker sites at `effectiveNamespace(state)` instead of the raw
   discipline → matchup metrics offered when Vs is on.
3. **Route `charts.js fetchSelectedPlayerMetrics` through the matchup query path when Vs is
   active** — the heavy lift. It must build a matchup-view query (per-bucket FILTER + coverage
   + the peak two-step), i.e. reuse `buildMatchupQuery`'s machinery rather than its own
   plain-view SELECT. Confirm at build start whether the existing **dumbbell** chart (which
   already compares two Vs scopes, decision 43) has a reusable matchup fetch.
4. Per-chart-type applicability: bar/donut/scatter/radar/benchmark take a matchup metric
   naturally; confirm phase charts + dumbbell; peaks (HS/Best Bowling) render like the table.
5. Verify charted Vs values against hand-written DuckDB; confirm the NON-Vs graph path stays
   byte-identical (anchors hold).

### Suggested routing (revisable)
- Wave A: `drawer.js` rename/reorder = frontend/Sonnet-high; Best-Bowling two-box condition =
  frontend+data-engineer/Opus-high (new UI type + number-adjacent); HS-as-Vs-condition =
  data-engineer/Opus-high; "(Innings)" label = Sonnet-medium.
- Wave B: data-engineer + frontend, **Opus/xhigh**, number-adjacent, independent verification.

---

## PART C — This-session owner rulings that constrain the work (log these into owner_decisions.md)
- Best Bowling condition = **two-box** (not dropped). High Score = a Vs **condition** (single box).
- **"Matchup (Vs)"** name, at the **top** of advanced filters.
- **Wire Vs into the Graph** (owner insisted it's "just a filter" — do NOT claim it's impossible).
- "(Innings)" tag dropped for limited-overs, kept for Test.
- 4c open items already ruled: Best Bowling renders **"2-9" (dash)**, keep; Matches + Runs/Innings
  **stay as Vs conditions** (auto-exposed, consistent with re-score model); HS/Best Bowling are
  columns-only until Wave A.
- **Player-popup FILTERS are OUT of this scope** — the owner never asked for it here (do NOT
  unify them). It's DEFERRED to later work, explicitly **linked to pending "sorting on the
  player graphs"** — design those two together when the owner raises them. (The player-popup
  *display* tables already have the Vs breakdown; leave the filter drawer bespoke.)

## PART D — Deferred / open (not this round unless owner says)
- Player-popup filter unification + player-graph sorting (paired, later).
- Popup/graph parity for the 4 new Vs stats beyond what Wave B delivers.
- Older deferrals still open: ~375px mobile one-screen fit; export-while-dirty.
- `owner_decisions.md` is authoritative and currently ends at **decision 48**; the coverage/4c/
  polish/Wave-A-B rulings above are NOT yet numbered there — log them.

## PART E — Pointers (do not duplicate; read the source)
- Contract + anchors: **`CLAUDE.md`**. Orchestration rules: **`.orchestrator/ORCHESTRATION.md`**.
- Decision log (authoritative): **`review/owner_decisions.md`**. Status board:
  **`.orchestrator/design-plan.md`** (per-wave notes in `.orchestrator/progress/`).
- Cricket calc law: `SPEC.md` §4.1. Data schema: `reference/db_reference.md`.
- Metric defs: `src/metrics.js`. Matchup query: `src/table.js buildMatchupQuery`. Condition
  compiler: `src/table.js conditionToHaving` + `src/advanced.js isMetricRemovedFromFilters`.
  Graph: `src/graph/graph.js`, `src/graph/charts.js`. Shared filter drawer: `src/drawer.js` +
  `src/drawerInnings.js`.

## STOP points (phase gates)
- Confirm you're oriented first: reproduce the **2,813 baseline on screen** before building.
- Build **Wave A**, verify each item + anchors yourself, commit, **STOP for owner go**.
- Then **Wave B** (largest single piece of the round). At its start, present the confirmed
  charts.js adaptation approach + per-chart-type applicability for a quick owner check.
