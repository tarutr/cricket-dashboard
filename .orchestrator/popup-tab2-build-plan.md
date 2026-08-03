# Player pop-up "Filters" tab — BUILD PLAN (living)

> Sub-program of the player-pop-up-on-ball-engine work (`.orchestrator/popup-ballengine-plan.md`);
> branch `ball-layer`, flag-gated `?engine=ball`; cuts over WITH the ball layer, not before.
> **Design FINALISED 2026-08-03** (terminology + per-row scope + shared discipline — see popup-ballengine-plan.md).
> **T0 mock SKIPPED by owner (2026-08-03).** Contract: CLAUDE.md — numbers sacred (Rule 1), owner decisions law
> (Rule 2), ask-before-building (Rule 3). Grounded in a read-only code map (2026-08-03).

## Architecture (grounded in code)
Each Filters-tab row = the leaderboard's own **`buildQuery` (UNCHANGED — numbers-sacred)**, scoped to ONE player via
the **already-precedented outer-wrap idiom** (used 3× in `src/graph/charts.js:56,208` + `src/graph/benchmark.js:154`,
whose header states the rule): clone `state` → set the row's per-row scope (Format / Team type / Date) + the tab's
shared Discipline + the row's own condition set (`advanced = {op,groups}`) → `buildQuery(rowState, cols)` → wrap
`SELECT * FROM (${sql}) t WHERE id = '<playerId>'`. **⇒ a no-filter row is byte-identical to that player's leaderboard
row — that is the correctness anchor.** Per-row condition sets are self-contained plain `{op,groups}` objects
(`src/advanced.js` + `src/addPalette.js` are store-independent by design; addPalette's header literally anticipates the
pop-up). Runs under `?engine=ball`.

### Key seams (file:line)
- `buildQuery` `src/table.js:897` (matchup `:287`); conditions live in `state.advanced = {op, groups:[{op, conds:[{metricKey,operator,v1,v2}]}]}` (`src/state.js:19`, `src/advanced.js`).
- Single-player scoping: outer-wrap idiom (no `idCol='X'` inside buildQuery — pins/teams use `IN`, search uses `ILIKE`).
- Palette: `src/addPalette.js` (extracted, store-independent). Full 7-group taxonomy `buildPaletteGroups` is PRIVATE in `src/drawer.js:822` and mixes WHERE-singletons (team/opp/event/venue/profile/R.Pos) + HAVING numerics — must be shared+configurable for the pop-up's reduced palette.
- Columns: `state.columns[discipline]` + `COLUMN_PRESET_DEFS` (`src/state.js:700`) + `eligibleMetrics()` are reusable; the PICKER UI (`openColumnsPopover`) is PRIVATE inside `mountTable`'s closure in `table.js` — **no shared component exists yet** (see Decision 2).
- Pop-up: `mountPlayerPage` `src/playerPage.js:226`, `showPlayer` `:602`; **single-view, NO tabs today**; existing "Player Filters" overlay (`src/playerFilters.js`) is a DIFFERENT 4-dim thing (Decision 1). `effectiveState()` `:250` = full state for table-row-opened pop-ups, PARTIAL for header-search-opened (needs defaulting).
- Ball-engine fast path: `singlePlayerId()` `src/db.js:314` needs a literal `idCol='X'` in the SQL text — the outer-wrap DEFEATS it, so per-row queries fall back to whole-scope reconstruction (mitigated by burst-folding). Perf item for T-4.

## Waves (each owner-gated to START; briefs trace to owner words)

| Wave | Task | Model / effort | Depends on |
|---|---|---|---|
| **A · T-F1** | **Tab scaffold** — add Overview\|Filters tab bar + 2nd mount div to `playerPage.js`; wire switching; new `playerFiltersTab.js` shell; Overview byte-identical. | frontend-engineer (Sonnet) high | — |
| **A · T-F2** | **Extract the shared column picker** from `mountTable`'s closure in `table.js` into a shared module; leaderboard uses it UNCHANGED (byte-identical). *(numbers-safe: UI only, query untouched)* | frontend-heavy (Opus) high | — |
| **A · T-F3** | **Make the "+ Add condition" palette shareable + per-context configurable** — relocate/export `buildPaletteGroups` into a shared module w/ a surface config (leaderboard = full; pop-up = drop the 4 Player-Profile filters + PotM-as-filter, keep Team + matchup). | frontend-engineer (Sonnet) high | — |
| **B · T-1** | **Opponent-player filter** — "X vs opponent Y" delivery filter on the ball engine (`bowler_id` batting / `batter_id` bowling) + a player-search picker in the Matchup group; lands on **leaderboard + Tab 2**. Independent head-to-head DuckDB verify. | data-engineer (Opus) xhigh | T-F3 |
| **C · T-2** | **The Filters tab** — rows = per-row `buildQuery` (clone state + per-row scope + tab discipline + per-row `{op,groups}`) wrapped `WHERE id='X'`; per-row editor = the real palette (Add condition flow, scope INSIDE each Add Filter Row popup, sticky); shared column picker (T-F2); literal-operator row labels + (i); pencil + ✕ inline; sort/pin; both buttons "Add Filter Row"; "No filtered rows yet"; no "slice". | frontend-heavy (Opus) xhigh | T-F1, T-F2, T-F3 |
| **D · T-3** | **Fielding in the tab** — wire the fielding source so Fielding Wicket Type ▸ / Wickets-by-Batting-Position filters + fielding columns work per-row. | data-engineer (Opus) high | T-2 |
| **E · T-4** | **Perf + integrated review** — measure per-row query perf under `?engine=ball` (fast-path fallback), optimise if needed; fresh-eyes Opus whole-diff review; anchors; cutover-ready. | Opus (fresh) xhigh | T-2, T-3 |

Wave A is 3 parallel tasks (different files: `playerPage.js` / `table.js` / `drawer.js`) — spawn together. T-1 after T-F3 (both touch the palette). T-2 after all of A. T-3, then T-4.

## Verification plan (every number-adjacent wave)
- **No-filter row == leaderboard row** for anchors (SA Yadav 60·1,544·29.13·150.34 batting; a bowler e.g. Bumrah) — byte-identical.
- **Each sliced row independently DuckDB-verified** (hand-written query, not the app's own shape) — e.g. one player's "Innings Score ≥ 100" row; "100+ vs ≤120" renders as two rows.
- **Leaderboard anchors unchanged** after the foundation refactors (2,813 / Karanbir 2,454; flag-off + flag-on).
- Opponent-player: an independent head-to-head count.
- `node --check` each touched file; serve localhost:8000; boot **0 console errors**; reproduce anchors on screen; `?engine=ball`.

## DECISIONS (owner, 2026-08-03 — ALL RESOLVED)
1. **The old "Player Filters" overlay is RETIRED** — the new tab-system replaces it (owner-approved removal). The
   overlay plumbing (`src/playerFilters.js` + `applyOverlay`/`requestedDims`/`overlayPillsHTML`/`scopeLine`/
   `activeOverlayCount`/`clearOverlayDim` overlay parts in `playerData.js`/`playerPage.js`/`playerSections.js`) is
   removed; Overview's base-profile numbers must stay byte-identical (it becomes the always-full-scope base profile).
   → folded into **T-F1**.
2. **Column picker EXTRACTED** into a shared module (foundation-first; the columns rejig later rebuilds that one
   module). → **T-F2**.
3. **Tab column choice is INDEPENDENT** of the leaderboard's (own selection, seeded from the discipline default).

## Status
Plan APPROVED by owner 2026-08-03; decisions 1–3 resolved (above). **Wave A SPAWNED 2026-08-03** — T-F1 / T-F2 /
T-F3 in parallel (worktree isolation; disjoint files). Live-browser anchor verification is DEFERRED to the
integration step (localhost:8000 / R2 CORS is a single-port singleton — can't run 3 servers at once); workers do
`node --check` + faithful implementation + self-diff-review + `wip:` commits + progress notes. Integration = merge
the three worktrees, then one browser pass (leaderboard anchors byte-identical + pop-up boots 0 errors).
