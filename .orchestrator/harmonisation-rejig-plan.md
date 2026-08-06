# Control harmonisation + filter/columns rejig — orchestrator plan (living)

> **Owner approvals (2026-08-02):** Full harmonisation of ALL pickers · phased "foundation-first"
> sequencing ("Go for it") · option **C** (search palette) as the "+ Add condition" model. Program
> runs on the **`ball-layer`** branch, behind `?engine=ball` where content is ball-only. Inputs:
> `.orchestrator/control-audit.md` (67-control inventory), `.orchestrator/filter-rejig-spec.md`
> (decision 68), `.orchestrator/ball-layer-design.md` (decision 67). Contract: `CLAUDE.md` — numbers
> sacred, owner decisions law. **NOTHING is built until the owner approves this plan; each wave is
> owner-gated to start.** *(Ball-layer cutover is a separate, later program — much sits between this
> work and it — and is deliberately NOT in this plan.)*

## Goal
One design language for every option-picker: a single shared **searchable custom panel** (single/multi,
optional search box) + one **segmented toggle** + shared **popover/date** components; **zero native OS
`<select>`s** (numeric operator provisionally exempt). The filter flow rebuilt as the option-C search
palette carrying decision-68's 7 groups, ▸ sub-filters, renames, and new metrics.

## Guardrails (every wave)
- **Numbers sacred (Rule 1):** control migrations are DISPLAY/INTERACTION ONLY — query builders
  byte-identical, every standing anchor reproduces on screen. The ONLY number-producing work is the new
  metric defs (Wave R1) → **data-engineer**, test-first, **independent DuckDB check** (decision-39 rule).
- **Owner decisions law (Rule 2):** the open sub-decision below is the owner's; briefs must not presume it.
- **Verification ritual:** serve localhost:8000 (ball files via the local `data/wave1_out` + `DATA_BASE_URL`
  override for engine-gated content); `fetch(cache:'reload')` changed files; `node --check`; boot **zero
  console errors**; anchors on screen; number-adjacent → independent DuckDB check.
- **Pre-build:** clean baseline commit on `ball-layer`; per-wave note in `.orchestrator/progress/`; `wip:`
  checkpoints ≤20 min of work.

## Waves (each owner-gated; briefs trace to owner words)

### Wave F — Shared control foundation  ⟶ GATES EVERYTHING
- **F1** Unified **Panel** component: merge checkbox-panel (P) + searchable-panel (S) into ONE — rounded
  popover, optional search, single/multi, checkbox/radio, full keyboard/focus/a11y, shared
  `wirePortalDropdown` positioning. API must cover all current P + S call sites. — **frontend-heavy (Opus) xhigh**
- **F2** **Segmented-toggle** standard (formalise `.segmented`; 2–4 options). — **frontend-engineer (Sonnet) high**
- **F3** Shared **popover** + **date** component scaffolding (date standard = **searchable month-list**,
  decided 2026-08-02). — **frontend-engineer (Sonnet) high**
- **F4** Prove it — migrate the cheap outliers: scope-strip Gender/Discipline → toggle; 5 profile pickers →
  panel. — **frontend-engineer (Sonnet) high**
- **Acceptance:** outliers render as custom controls; numbers/anchors unchanged; keyboard + 375px mobile pass; 0 console errors.
- **Nothing blocks F1–F4** — this wave can start the moment the plan is approved.

### Wave R — Filter rejig (on the foundation) *(owner sequence: filters first)*
- **R1** New metric defs — Boundary Run % (bowling) · Innings Score ≥ N · generalised Wicket Hauls ≥ N ·
  Extras (wides/no-balls) · Innings Number · expanded % Runs in… — sqlExpressions over stored columns. —
  **data-engineer (Opus) xhigh, numbers-critical, independent verify.** *(Independent of F — may run in parallel.)*
- **R2** "+ Add condition" → option-C **search palette = the shared panel** + 7 groups + ▸ sub-filters;
  renames (display-only); picker deletes; fold the 4 delivery-window entries into **Ball Ranges**. —
  **frontend-engineer (Sonnet) high**
- **R3** Part B — replicate palette + all filters into the **Graphs filters popup** + **player pop-up drawer**. —
  **frontend-engineer (Sonnet) high**
- **Acceptance:** no-window anchors byte-identical; new metrics == independent DuckDB; every filter control is
  the shared language; 3-surface parity.

### Wave C — Columns rejig *(owner sequence: after filters)*
- Rebuild the **Columns popover on the shared panel**; by-phase breakdown columns move HERE (not filters);
  renames/numerals. — **frontend-engineer (Sonnet) high.** *(Numbers-adjacent existing columns → verify anchors.)*

### Wave P — Columns-in-filters-popup + Column presets
- **P1** "Columns shown" section in the popup mirroring the toolbar Columns dropdown, auto-minimised. —
  **frontend-engineer (Sonnet) high**
- **P2** Column **presets FROM SCRATCH** — a design/mock is **produced and shown to the owner** for sign-off
  BEFORE any build (previously rejected; no abstract sign-off).

### Wave S — Harmonisation sweep *(surfaces the rejig didn't touch)*
- Graphs-panel + Graph-Chooser metric/axis/chart pickers → unified panel (fix N-vs-S metric mismatch).
- Merge the 3 type-to-search impls (omnisearch / search-select / graph bespoke) → one.
- Dates → **searchable month-list** everywhere (decided). Delivery Phase → **panel** (decided) — retire chips for categorical multi-selects.
- Remove dead code (`.team-dropdown` CSS, `monthOptionsHTML`). — **frontend-engineer (Sonnet) high.**

### Wave Z — Integrated review
- Fresh **Opus xhigh** whole-diff review: one language everywhere, anchors, 0 console errors, no dead/dup code.

## Sub-decisions
- **RESOLVED (2026-08-02): Date standard = searchable month-list** (S pattern) everywhere — replaces native day-pickers.
- **RESOLVED (2026-08-02): Delivery Phase → panel.** All categorical multi-selects use the checkbox panel —
  including the delivery-window Phase (its chips retire). Chips are no longer a categorical pattern; segmented
  toggles remain ONLY for exclusive on/off choices. *(Unaffected: Over/Ball **range** number inputs stay inputs;
  the First/Last edge stays a segmented toggle — neither is a categorical multi-select.)*
- **Presets:** a design/mock is shown to the owner for sign-off before Wave P2 builds (no abstract sign-off).

## Dependency graph
F gates R2/R3/C/P/S. **R1 ∥ F.** C after R (owner sequence). S after F (∥ R/C by surface). Z last.

## Status
Plan approved; **Wave F started 2026-08-02.**
- **R1 (new metrics): ✅ COMPLETE + independently verified** (commit `acbb9a1`). 6 metric families added to
  metrics.js, additive-only, no query builder touched; numbers triangulated from TWO independent sources
  (ball-layer hand-derivation + shipped innings parquet); anchors unchanged. **Carry to R2:** add the
  `4s-boundary`/`6s-boundary` % splits (trivial), and rename BOTH boundary% metrics to "Boundary Run %"
  in the display sweep. Parametrised metrics (Innings Score ≥ N, Wicket Hauls ≥ N) show a default N until
  R2 wires the sub-filter input. Details: `.orchestrator/progress/waveR-metrics.md`.
- **F1 (unified panel): ✅ COMPLETE + verified** (commits `1294a3b`, `0095aa9`). searchSelect.js extended to
  the superset (optional filter box: `searchable:true|false|'auto'`); 5 profile pickers + R.Pos migrated to
  panels; additive/widget-only (no query builder, no state-shape change); boots 0 console errors; 0 native
  `prof-` selects remain; anchors hold. **Sweep gotcha:** panel-scoped `--no-filter` class (host-scoped fails
  under portal); value-based summaries need the closure-over-handle pattern. Details:
  `.orchestrator/progress/waveF-panel.md`.
- **F2 (toggle + Gender/Discipline): ✅ COMPLETE + verified** (commit `93b210c`). New `src/segmentedToggle.js`
  helper (reuses `.segmented`); Gender + Discipline migrated to toggles on BOTH surfaces (Stats + Graph popups);
  `buildScopeClauses` untouched; 0 console errors; toggle drives re-scope (Bowling↔Batting); anchors hold
  (worker independent DuckDB 2,813 + on-screen 2,813/Karanbir 2,454/SKY 60·1,544·29.13·150.34); removed 1 dead
  CSS rule. Details: `.orchestrator/progress/waveF-toggle.md`.
- **F3 (date component): DEFERRED to Wave S.** Shared popover already delivered by F1's searchSelect portal;
  the searchable month-list has NO consumer until the date migration in the sweep. Deferred, not dropped.
- **F4 (prove the outliers): ✅ delivered via F1 (profile pickers + R.Pos → panel) + F2 (Gender/Discipline → toggle).**

### ✅ WAVE F COMPLETE (2026-08-02) — foundation laid + verified.
### ▶ WAVE R STARTED (owner go 2026-08-02): R1 ✅ done+verified · **R2 (palette) ✅ COMPLETE + verified** (commits `ebf948d`/`71f6815`/`b2736f6`) — option-C search palette, 7 groups, ▸ mechanic, renames, deletes, delivery-window→Ball Ranges fold, new metrics wired (+2 boundary splits independently checked); no query builders touched; anchors hold (2,813/Karanbir 2,454, flag-off + flag-on; Powerplay→1,570). Details: `.orchestrator/progress/waveR2-palette.md`.
  - **R2b — CORRECTIVE REWORK in progress (owner go 2026-08-02):** R2 misread the spec in 4 places (owner
    caught it). Fixes: (1) **Fielding Stats = ONLY the 2 ▸ slices** — remove standalone Catches/Stumpings/Run-outs
    + PotM leaves + the leftover catch-all. (2) **Remove 4-WI/5-WI** (subsumed by Wicket Hauls ≥ N). (3) **Innings
    Number ▸ → Batting/Bowling Basic** (remove "Innings order" from Match Details) — needs `buildScopeClauses`.
    (4) **≥ N live input** for Innings Score / Wicket Hauls — needs `conditionToHaving` per-condition N.
    PLUS **new metric PotM Count** (`SUM` PotM awards; in Player Profile after Reg-Pos, before Team). Additive
    query-builder work AUTHORIZED (anchors byte-identical; independent-verify). frontend-heavy/Opus, 2 phases.
  - **R2c — completion build in progress (frontend-heavy/Opus):** Innings Number ▸ (proper filter, moved to Basic; "Innings order" removed), Fielding Wicket Type ▸ **count operator** (restores ≥ N catches/stumpings/run-outs), + **restore the 4 dropped matchup stat filters** (balls faced/dismissals vs style; fours/sixes conceded vs hand).
  - **REMOVAL AUDIT (2026-08-02, mechanical `93b210c`→`c12afc3`): NO silent removals beyond the 4 known matchup filters.** Every other removal traces to the spec Deletes list or a rename. TWO capability reductions to close: (a) fielding count filters — restored by R2c's count operator; (b) **matchup_bowling lost boundary-concession filtering** — deleted `boundary_pct_conceded`'s replacement `boundary_runs_pct` was added to batting/bowling/matchup_batting but NOT matchup_bowling. **FIX (tracked, after R2c):** add `boundary_runs_pct` to matchup_bowling + place "Boundary Run %" in matchup-bowling Detailed (numbers-critical → independent-verify). Also update the spec Deletes list to record replacement namespace-coverage so this class of gap is visible.
  - **R2c: ✅ COMPLETE + verified** (commits `046b767`/`14b08da`/`dceb748`). Innings Number ▸ wired end-to-end (SKY inns-1 = 38, count 2,558; "Innings order" removed); Fielding Wicket Type ▸ count operator (Caught→catches/Run-out→run_outs/Stumped→stumpings; "Catches ≥ 10" = 432); 4 matchup filters restored. `buildQuery`/`buildMatchupQuery` untouched; anchors hold; 0 console errors; both surfaces.
  - **R2d — GAP-CLOSE pass: ✅ COMPLETE + verified** (commits `2bba032`/`2e9c92a`/`5842320`). (A) MAT innings-level under Innings Number — one authorized line in buildQuery's `inningsLevel` gate (SKY inns-1 MAT 64→38); buildMatchupQuery untouched; anchors byte-identical. (B) matchup_bowling Boundary Run % (independent: Bumrah vs RHB = 55.2%). (C) Caught & bowled fielding count (independent: Karanbir = 3; also now an available column like its 3 siblings — columns-rejig will revisit). Details: `.orchestrator/progress/waveR2d.md`.
  - **Cleanup — ✅ COMPLETE + verified** (commit `bd9bf08`). Inert `mc_innings_order` + `fld_kind` plumbing removed across 6 files; zero live refs; table.js untouched; anchors hold. `fld_pos` kept.
  - **`fld_phase` — owner-confirmed DELETE (2026-08-02): covered by Fielding Wicket Type ▸ + Ball Ranges → Phase (composition).** Its inert plumbing + the residual table.js fielding-slice clauses → **tracked for the Wave S sweep.** VERIFY-LATER: confirm Ball Ranges Phase actually narrows fielding events (the basis for this delete) when the window is verified end-to-end. Two "Caught" labels (Dismissal Type = batter's, Fielding Wicket Type = fielder's) — per spec.
- **R3 (Part B — player pop-up): Phase 1 ✅** (palette extracted to `src/addPalette.js`, leaderboard byte-identical, `8a44f1a`). **Phase 2 became its own program** — the pop-up ran a separate 4-dim mini-engine, so Option 3 (rebuild on the ball engine) was chosen. **P0 ✅ / P1 ✅ done; Tab-2 "Filters" design SIGNED OFF (2026-08-03); ⛔ STUCK on the T0 mock** (hallucinating hand-mocks + a broken real-component preview). Full spec, decisions, status → `.orchestrator/popup-ballengine-plan.md`.
- **FUTURE — AND/OR filter logic (after the columns rejig).** Filters currently only AND together; owner wants searchable **AND/OR** combinations (e.g. "SR in innings scoring 100+ **vs** under 50"). Applies to BOTH the main filters popup and the player pop-up. Dedicated design pass, sequenced AFTER the columns rejig. Not designed yet.
**Carry to Wave S (sweep):** consolidate the THREE segmented-toggle implementations (`segmentedToggle.js`
+ `main.js` view toggle + `playerPage.js` Batting/Bowling) into one. Plus the F1 portal/summary gotchas above.

## REMAINING ORDER (owner-confirmed 2026-08-03)
The leaderboard **filters rejig is COMPLETE** (Wave F + R landed + verified). Remaining, in order:
1. **Player pop-up Tab 2 — ✅ BUILT (2026-08-03), all on `ball-layer`.** T0 mock SKIPPED (owner). Delivered:
   Wave A (scaffold + overlay retire + shared columns/palette extraction) → T-1 opponent-player → T-2a..e
   (slicing engine, editor, scope singletons, matches-fix, matchup Vs + batting position) → T-3a/ext/b (fielding
   mode) → retrofit (data-driven filter availability, `cac8dfe`). **NEXT = the overall pop-up review in a FRESH
   session** — see `.orchestrator/popup-tab2-review-handoff.md`. (T-4 perf folds into the pre-cut integration.)
2. **Columns rejig** — Columns popover → shared panel; by-phase columns move here; renames. *(Tab 2 reuses the
   shared column component, so it picks up this rejig automatically — no reorder needed.)*
3. **Columns-in-filters-popup**, then **column presets** (design shown to owner first).
4. **AND/OR filter logic** — design pass (owner placed it after the columns rejig; applies to the main popup AND
   the player pop-up).
5. **Harmonisation sweep** (Wave S) — Graphs pickers, merge the 3 search boxes into one, dates, **discipline →
   dropdown everywhere** (owner-decided, deferred here), dead-code (`fld_phase` + the table.js fielding-slice
   residuals + the 3 toggle impls).
6. **Integrated review** (Wave Z).
7. **Ball-layer cutover** — LAST, separate, owner-gated.
