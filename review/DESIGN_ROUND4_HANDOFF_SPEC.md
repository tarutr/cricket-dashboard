# Spec: cricdb design phase — Round 4 + cleanup (fresh-session handoff)

## Read this first — the two rules that override everything

You are continuing an in-flight UI/UX design phase on an existing, working app. A prior
session did Rounds 1–3 (all committed). Your job is Round 4 + a cleanup pass. Two framing
rules dominate every task:

1. **Numbers are sacred; you only change WHEN and HOW things display, never WHAT a query
   returns.** The query builders — `buildQuery`/`buildMatchupQuery` in `src/table.js`,
   `buildScopeClauses` in `src/filters.js` — must stay byte-identical unless a task
   explicitly says to change an option-list query (Round-4 item A9). There is a set of
   **standing anchor numbers** (below). If any move, you touched calculation logic — revert.

2. **Take the owner's instructions literally and completely. Do NOT invent exceptions to a
   stated rule.** The last session repeatedly over-corrected and under-corrected by adding
   caveats the owner never asked for (e.g. gating column-sort behind Search when the owner
   only meant the *query* controls). When a rule says "X is instant," make X instant — don't
   decide a sub-case should differ. If you are genuinely unsure, **ask before building.**

The owner is **non-technical**: every checkpoint in plain English (name the control and what
changed, never raw diffs). Work in **gated waves** — build a coherent chunk, verify it
in-browser against the anchors, commit, then **STOP for the owner's go** before the next.

## Repo / branch / current state

- Repo `/Users/tarutr/Desktop/live_db`, branch **`polish-b1-mechanical`** (`main` is
  production and stays untouched; merging is a separate owner decision, out of scope).
- Read `.orchestrator/design-plan.md` — the running log of Rounds 1–3 (what each wave did,
  file refs, decisions). It is the memory of how the current state was built.
- The app: a men's + women's cricket stats explorer. Static browser app, plain ES modules,
  no framework, DuckDB-WASM querying Parquet on Cloudflare R2. Two views: **Stats** (a
  leaderboard table) and **Graphs** (a chart builder). No automated test suite.

**Already done (Rounds 1–3, committed):**
- R1: slim page header; Graph Builder fits one screen; slope/dumbbell windows start empty
  with a red `needs-input` outline; the graph has an **"Update chart"** button that gates
  its in-panel controls (change controls freely, only Update chart redraws).
- R2: a reusable **searchable dropdown** `src/searchSelect.js` — `mountSearchSelect`
  (single-pick) and `mountSearchMultiSelect` (multi-select); typeahead + keyboard + ARIA,
  panel capped 15rem with internal scroll, optional `portal` flag for overflow popups.
  Applied to the graph's chart-type + metric pickers + radar/benchmark, and to the filter
  drawers' Team/Opposition/Event/Venue. The **Donut chart was REMOVED** from the Graph
  Builder (`buildDonutChart` is retained in `src/graph/charts.js`, flagged "RETAINED FOR
  LATER" for a future player-popup donut — do not delete it).
- R3.1: removed the Advanced-Filters **"Name"** condition; made **"Reg. Batting Position"**
  batting-only (absent in the bowling condition list; still present in matchup mode where the
  same dropdown entry powers the striker-position filter — keep that path).
- R3.2: rebuilt the **Stats toolbar** as a single row —
  LEFT `[ Filters · Search(player) · From–To dates · preset ▾ · [ Vs │ value ] ]`,
  RIGHT `[ count · Search · Columns · Clear ]`. Introduced a **pending-until-Search** model
  (the toolbar Search button, replacing the old Graph button, commits pending edits +
  queries). Toolbar visible on first load; dates live in both the toolbar and the Filters
  popup (synced); Vs added to the popup as a "+ Add condition" after Innings (synced with the
  toolbar); the top-strip Stats↔Graphs toggle now seeds the graph pool. Tighter gaps + a
  longer table.

**R3.2 OVER-GATED — that is the first Round-4 fix (item A1).** The owner's rule is subtler
than "everything waits for Search": **which ROWS are shown (the query) waits for Search;
HOW the loaded rows are displayed (sort order, columns) is INSTANT.**

## Standing anchor numbers (the correctness tripwire)

Scope **Men / T20 / International**, date range **2023-07-01 → 2026-07-02** (day-bounded —
these hold only with that exact range; data rolls forward daily):
- Batting baseline **2,813 players** (top row Karanbir Singh **2,454**).
- SA Yadav: **60 inns / 1,544 runs / avg 29.13 / SR 150.34**.
- Matchup: **Bumrah vs RHB, positions 1–2 = 27 inns / 177 balls / 9 wkts**. SA Yadav vs Spin
  = 38 inns / 454 runs / SR 140.99, coverage 913 of 1,027 balls.
- DuckDB-WASM returns SUM aggregates as **BigInt** → wrap in `Number()` before comparing.

## Verification (how to prove a change is safe)

- Serve on **localhost:8000**: `python3 -m http.server 8000` (background), open
  `http://localhost:8000`. R2 CORS allows only `localhost:8000` / `127.0.0.1:8000` — no other
  port/host loads data. Leave the server running for the orchestrator's verification.
- Browsers cache ES modules hard — after editing, `fetch(path, {cache:'reload'})` each
  changed file then `location.reload()` before re-checking. If the automated browser pane
  reports a 0×0 viewport, resize it (1280×800) before trusting scroll measurements.
- After every wave: `node --check` each touched `.js`; boot with **zero console errors**;
  reproduce the anchors on-screen (2,813 + SA Yadav) and, wherever an **option-list or
  query-adjacent** change was made (item A9), verify independently via a direct DuckDB
  console query — `import('/src/db.js').then(m => m.query('SELECT …'))` — never by reusing the
  app's own aggregation shape.

## The Round-4 work

### The instant/pending model (item A1) — get this exactly right, it caused the most friction
The owner's FINAL, literal decision (do not add or remove entries):

| Control | Behaviour |
|---|---|
| Column **sort** (click a header) | **INSTANT** — re-sort the loaded rows + re-render on click; do NOT light the Search button |
| **Columns picker** (add/remove) | **INSTANT** |
| Column **drag-reorder** | **INSTANT** (and stop lighting Search) |
| **Mobile name-expand** (double-tap) | **INSTANT** (likely already is — verify) |
| Results-toolbar **player search** | **INSTANT** |
| **Preset dropdown** (column sets) | **PENDING** (waits for Search) |
| **Filters** / conditions | **PENDING** |
| **Dates** | **PENDING** |
| **Vs** | **PENDING** |

R3.2 wrongly made sort, columns picker, drag-reorder, and player-search wait for Search.
`table.js`'s `applySortKey` (~line 1938) has a comment "No client-side re-sort / re-render
here anymore — pending until Search" — that is the bug; restore instant client-side re-sort +
re-render. Note the split: **preset dropdown is PENDING but the Columns picker is INSTANT**
(the owner chose this deliberately — do not "unify" them). The pending controls keep flowing
through R3.2's applied-state snapshot + Search button; the instant controls apply live to the
already-loaded rows with no re-query and no Search light.

### A2 — Pills reflect PENDING, not applied
R3.2 renders the filter pills from the frozen applied snapshot, so clicking a pill's × looks
inert until Search. Make the pills reflect **pending** edits (like the toolbar controls do),
so a pill × removes it from the pending set immediately. The TABLE stays frozen until Search;
only the pill indicator becomes live. (This is not an exception to the query-waits rule — the
pill is an indicator, and it should match the other controls, which already show pending.)

### A3 — Recolour the manually-added-player ("pin") pills off red
"Pins" = manually-added players: when you search a player and pick them, they're **added** to
the table (not filtered) as a **"+ Name"** pill. Today these use `.pill--pinned` = a red tint.
Recolour them to a blue/accent that fits the editorial off-white/ink-navy palette (your
judgment). Reason: red is being freed for the delete state (A4).

### A4 — Pill soft-delete with undo
Clicking any pill's × should **soft-delete**: the pill gets a **red outline** and the **×
flips to a +**; clicking the + **restores** the pill (× returns). This gives an undo for an
accidental delete and a clear "this is removed" signal. Works together with A2/A3 (pending
pills; pins no longer red so the red delete-outline stands out).

### A5 — "Keep Selected Columns" toggle
Add a **"Keep Selected Columns"** checkbox in the **Filters-popup footer, to the LEFT of the
Search button**, **default OFF (unticked)**. When OFF, a new Search **resets columns to the
scope default**; when ON, the user's current columns + order **persist** across the new
search.

### A6 — No-data pin feedback
When a pinned/searched player has **no rows in the searched scope**, show their pill with a
**"(no innings)"** annotation AND a **toast**. (R3.2 dropped the old toast+rollback, so a
missing pin currently just silently yields no row — confusing.)

### A7 — Vs/matchup silent-filter-drop (a real confusion to resolve)
Entering matchup mode via **Vs = Pace/Spin/etc.** silently **drops the plain-mode-only
"R. Pos." (`state.regularPositions`) filter** — the Filters badge count drops (e.g. 2→1), the
R.Pos pill vanishes, and the player count jumps UP (because a narrowing filter disappeared).
This reads like a bug. Investigate and handle it gracefully: either **warn the user** that the
filter doesn't apply in matchup mode, keep the pill visible-but-inert, or otherwise make the
count change legible. **Matchup VALUES must stay exact** (Bumrah vs RHB pos 1–2 = 27/177/9) —
`buildMatchupQuery` is untouchable. First confirm the mechanism in-browser (it is inferred
from owner screenshots), then choose the least-surprising fix.

### A8 — Graph rename
In the Graph controls, rename **"Reset to filtered set"** → **"Reset to full filtered set"**.

### A9 — Advanced-filter option lists must respect the full Search Conditions (number-adjacent)
Today the Team / Opposition / Event / Venue option lists in the Filters-popup drawers scope
only to **gender + team-type** (a deliberate old design). The owner wants them scoped to the
**FULL Search Conditions: gender + format + date + team-type** — so "Men's, last month" only
lists teams/events/venues that occur in that window. Change the loaders
(`src/playerData.js` `searchTeams`/`searchEvents`/`searchVenues`, and how the
`drawerInnings.js` loaders call them) to add the format + date scoping. **Verify
independently** (DuckDB): e.g. an event/venue list under a narrow date window shrinks to only
those in-window, and the baseline picker under the full range is unchanged.

### B — R2-2b-iii (unfinished from Round 2)
Convert the **player-popup** selects — **Against / Vs / Date-window** in
`src/playerFilters.js` — to the `searchSelect` component (completing the R2 "make every
search bar like the header" sweep). Short native selects; single-pick. Verify the popup still
filters correctly.

### C — End-of-phase documentation sync (do LAST, after the design work settles)
A Sonnet/high doc pass: log the design rounds in `review/owner_decisions.md`; update
`reference/CHART_SYSTEM.md` (donut removed, one-screen graph layout, searchable dropdowns,
Update-chart + pending-until-Search gating, the new Stats toolbar); fix stale donut/layout
mentions in `README.md` and `SPEC.md`.

### D — Hygiene sweep (grep-proven dead code only)
Dead CSS: `.graph-radar-metrics__*` / `.graph-benchmark-metrics__*` (unreferenced after R2),
and the R3.2-superseded toolbar classes `.table-toolbar__dynamic/__actions/__controls/
__graph-columns/__group-label/__presets`, `.chip--preset`, `.table-toolbar__matchup-note`,
`.select--compact`, `.table-prompt*`. Grep-prove non-reference before removing. File-size
overages over the ~600-line guideline (`searchSelect.js` ~714, `drawer.js` ~726, plus
`graph.js`/`table.js`/`styles.css`) — a split is OPTIONAL and plan-only unless the owner asks.
Note: the benchmark metric picker lost its in-dropdown group headers in R2 (the chart still
shows them) — cosmetic, owner-aware.

### E — Deferred / open (do NOT do unless the owner raises them)
Mobile ~375px residual outer scroll (owner-deferred since R1). Column drag drop-index +
mobile double-click-expand were flagged for manual pointer testing (automation can't drive
pointer-drag cleanly).

## Suggested wave order (each = its own owner gate; revisable with justification)

1. **Wave 4a — instant/pending correction + pills** (A1, A2, A3, A4). One frontend agent,
   **Opus/high**, owns `table.js` + `main.js` + `pills.js` + `styles.css` (pill colours +
   soft-delete). This un-does R3.2's over-gating and does the pill work — tightly coupled,
   keep it one agent. Verify: sort/columns/drag/search instant + no Search light; dates/Vs/
   filters/preset still wait; pills pending; pin recolour + soft-delete-undo; anchors 2,813.
2. **Wave 4b — Keep-Columns toggle + no-data pin feedback + Vs filter-drop + graph rename**
   (A5, A6, A7, A8). Frontend **Opus/high** (A7 touches matchup-mode logic — care), + the
   trivial A8 rename inline. Verify matchup anchor.
3. **Wave 4c — option-list scoping** (A9). Frontend/data-engineer **Opus/high**, owns
   `playerData.js` + `drawerInnings.js`. NUMBER-ADJACENT → independent DuckDB verification of
   the shrunk lists + unchanged baseline.
4. **Wave 4d — R2-2b-iii popup selects** (B). Frontend **Sonnet/high**, owns `playerFilters.js`
   (+ small CSS). Lower risk.
5. **Wave 4e — docs + hygiene** (C, D). **Sonnet/high**. Last, after the design settles.

## Definition of done
- Every touched `.js` passes `node --check`; the app boots on localhost:8000 with **zero
  console errors**; the standing anchors reproduce exactly (2,813 / SA Yadav / Bumrah matchup)
  on-screen and — for A9 — via an independent DuckDB query; a hands-on pass of the core Stats
  and Graphs flows behaves as the owner specified.
- The instant/pending table (A1) matches EXACTLY; pills are pending; pins recoloured; pill
  soft-delete-undo works; Keep-Columns toggle behaves; no-data pin shows "(no innings)" + a
  toast; the Vs filter-drop is no longer confusing; option lists respect the full conditions.
- The owner reviews each wave on localhost:8000 and signs off; merge to `main` is a separate
  owner decision, out of scope.

## Open questions / things to confirm with the owner before the relevant wave
- **A7 (Vs filter-drop) mechanism** is inferred from screenshots — confirm in-browser before
  choosing the fix, and confirm which handling the owner prefers (warn vs. inert pill).
- **A3 pin colour** — pick a colour and show it; the owner said "blue, green, whatever you
  think," so choose, but surface it at the gate for a thumbs-up.
- **A9** reverses a deliberate old design decision — confirm the owner wants ALL four
  (Team/Opposition/Event/Venue) scoped, and that the option lists shrinking as they set
  format/date is the intended feel.

## Orchestration model (carry over)
Opus 4.8 orchestrator: plan → decompose → delegate to right-sized subagents
(`frontend-engineer` / `design-stylist` / `data-engineer` / `Explore`) with an **explicit
model + effort per spawn**, stated with a one-line why. Concurrent agents only on **disjoint
files**. Number-adjacent SQL edits get **independent DuckDB re-verification** by the
orchestrator (not the agent's word). Commit **per wave** with a thorough plain-English
message; **STOP for the owner's gate between waves**. Keep the running log in
`.orchestrator/design-plan.md`. Agents should leave the localhost server running for the
orchestrator's verification pass.
