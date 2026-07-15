# Spec: cricdb whole-codebase health & cleanup pass

## The real goal — read this before anything else

The cricdb app was built over seven intense rounds of UI/feature polish. It works and the
owner is happy with **what it does**. This project is a **health, efficiency, and cleanup
pass** — make the code leaner, faster, and free of latent flaws **without changing a single
thing the app does or a single cricket number it shows.**

The single most important framing: **correct behaviour and exact numbers are sacred.** A
cleanup that removes dead code is good; a "cleanup" that moves a displayed stat by even 0.01
is a failure, no matter how tidy the diff. There is a set of **standing anchor numbers**
(below) that act as a tripwire — if any of them change, you touched calculation logic and
must revert/rework. Treat those anchors as ground truth.

The owner is **non-technical and cannot read code.** Every checkpoint you present must be in
plain English (name the file and what changed and why it's safe, not the diff). "Done" means:
the app behaves **identically** (proven by the anchors + a hands-on browser pass) and is
**measurably leaner** (report the line/dead-code delta), and the owner has signed off.

**Work report-first, then fix in gated batches** (the owner's explicit choice). Do not
start editing code until the owner has approved the health report.

## Inputs

Repo: `/Users/tarutr/Desktop/live_db`  ·  Branch: `polish-b1-mechanical` (80 commits ahead of
`main`; `main` is production/deployed and must stay untouched — the owner gates the merge
separately, and merging is NOT part of this project).

Inventory everything before designing. Status of each area:

- **LIVE APP — behaviour is ground truth, preserve exactly:**
  - `src/*.js` (~17,600 lines, 32 modules) — the browser app (plain ES modules, no framework).
  - `styles.css` (4,338 lines), `index.html` (140 lines).
  - `src/db.js` — DuckDB-WASM data layer over Cloudflare R2 parquet files.
- **LIVE DATA PIPELINE — data-critical, change with extra care (test-first):**
  - `export_parquet.py` (builds the parquet files the app reads — the cricket-correctness SQL lives here).
  - `pipeline/*.py` — ingest, download_db, upload_db, build_profiles, check_ingest, alerts,
    state_store, sheet_fetch, report/queue scripts. Runs on GitHub Actions (`.github/`).
- **LIKELY STALE — candidates to prune, but CONFIRM with the owner before deleting:**
  - `v1_pipeline/`, `v1_reference/` (old reference implementations), `scratchpad/`
    (incl. `scratchpad/matchup_ext_pos/export_parquet_OLD.py`), `debug/`, `analysis/`,
    `reference/`, `__pycache__/`. Do **not** assume — some may be referenced by docs or the
    owner's workflow. `data/`, `source_data/` may be needed for local pipeline runs — verify.
- **AUTHORITATIVE HISTORY — read this first:** `.orchestrator/plan.md` in the repo. It records
  all seven rounds, every commit, the known accumulated debt, the standing anchors, and the
  tooling workarounds. It is the closest thing to the memory of how this was built.

## Background (self-contained — the executor has no memory of the build)

**What the app is.** cricdb is a men's + women's cricket statistics explorer. A Filters popup
sets the scope (Gender · Discipline · Format · Team type · Date); "Search" is the only query
trigger; results render in a leaderboard table; a Graph Builder visualises them; a player
popup shows per-player splits. All querying is DuckDB-WASM in the browser over R2 parquet.

**Format buckets (3):** Red Ball (match_type Test+MDM), 50 Over (ODI+ODM), T20 (T20+IT20).
Team type (International/Domestic) is independent of format.

**Standing anchor numbers — the correctness tripwire.** With scope Men / T20 / International
and the day-bounded date range **2023-07-01 → 2026-07-02** (the data rolls forward daily, so
these hold only with that exact range):
- Batting baseline: **2,813 players**. Bowling baseline: **2,049 players**.
- SA Yadav (Suryakumar Yadav): **60 innings / 1,544 runs / avg 29.13 / SR 150.34**; vs Spin
  **38 inns / 454 runs / SR 140.99**; style coverage **913 of 1,027 balls**.
- Bumrah vs RHB, positions 1–2: **27 / 177 / 9**.
- Header-search player popup uses a DIFFERENT fixed scope (since 2020-01-01, T20, both team
  types): SA Yadav there = **205 inns / 6,345 runs / 36.05 / 159.90**.
- Data max match date ≈ **13 Jul 2026** (rolls daily; the footer + date defaults read it).
- DuckDB-WASM returns SUM aggregates as **BigInt** → `Number()` before comparing. `query()`
  in `src/db.js` returns `{ rows, ms }`. You can run independent number checks in the browser
  console: `import('./src/db.js').then(m => m.query('SELECT …')).then(r => …)`.

**Known accumulated debt (LEADS, not an exhaustive list — find more).** Flagged during the
build but never cleaned:
- `src/graph/benchmarkChart.js` — a dead `if (r.anchorMuted)` branch (the field is never set
  anymore); the matching CSS `.paper-card__benchmark-anchor-value--thin` is orphaned.
- `src/state.js` — `describeScope` "grouped by" token and residual `splitBy`/Group-rows
  plumbing that nothing sets anymore (the Group-rows UI was removed).
- `src/graph/*` — `benchmarkFloorNotes()` is a `[]` stub kept only for an import; a
  `formatMetricValue` in charts.js was long ago noted dead (`labelForValue` is the live one).
- `src/playerSections.js` — `overlayTokens()` unused-but-exported; `scopeLine()`'s
  `fixedDefault` param is now unused.
- `src/playerData.js` — the suggestion-search `appearances` CTE runs a full-table
  `COUNT(DISTINCT match_id)` (now limited to hit ids, but double-check); `esc()` escapes
  single quotes but not LIKE wildcards `%`/`_` (a pre-existing quirk).
- `scratchpad/matchup_ext_pos/export_parquet_OLD.py` — stale copy.
- **Oversized files** (over the project's ~600-line guideline): `src/graph/graph.js` (3,324),
  `src/table.js` (2,218), `src/metrics.js` (1,654), `src/graph/charts.js` (1,066),
  `styles.css` (4,338).

**Tooling / how to verify (there is no automated test suite).**
- Review runs on **localhost:8000**: `python3 -m http.server 8000` (background) then open a
  browser at `http://localhost:8000`. (R2 CORS blocks Vercel previews — localhost only.)
- The browser caches ES modules — after editing a file, `fetch(path, {cache:'reload'})` it
  then `location.reload()` before re-checking.
- Every anchor check must be done both **on-screen** and, where calc-adjacent code changed,
  **independently** via a direct DuckDB query (do not reuse the app's own aggregation shape to
  "verify" the app — derive counts independently).

**Owner working style (carry these over).** Non-technical → all checkpoints in plain English,
name exact buttons/screens. Delegate builds to right-sized subagents; the top model
orchestrates and reviews, it does not hand-write large modules. Keep subagent scopes small and
files disjoint (subagents have died at session limits on big tasks). ≤2 subagents concurrent.
Checkpoint-commit before big agents; check `git status` after any failure. **The owner gates
every batch** — never batch-merge or proceed to the next wave without a go. **Do not
unilaterally narrow a request or carve out exceptions; if you have a genuine question, ask
before building, don't decide it silently.**

## Phase gates (STOP points — the owner chose report-first, gated batches)

**GATE 1 — Health report (read-only, no edits yet).** Do a whole-codebase review across:
efficiency, redundancy/duplication, dead code, correctness/latent-bug risks, the data
pipeline, dependency/security hygiene, and stale-folder cleanup candidates. The
`/opus-code-check` skill is purpose-built for this (graded, read-only) — use it or an
equivalent. Produce a **plain-English graded report** grouped by severity, each finding with:
what it is, why it's safe (or risky) to fix, and which batch it belongs to. Include the
proposed batch plan (below) and the stale-folder prune list (as a proposal, not an action).
**STOP. Present the report to the owner and wait for approval before editing any code.**

**GATE 2…N — Fix in reviewable batches.** Suggested order (each batch = its own gate):
1. Dead-code + orphaned-CSS removal (grep-proven unreferenced).
2. Redundancy / duplication consolidation (shared helpers).
3. Efficiency (query/render/loader improvements that produce byte-identical output).
4. Latent-bug fixes that do NOT change current correct behaviour (e.g. the `esc()` wildcard
   quirk) — anything that WOULD change visible behaviour is a separate owner decision, not a
   silent fix.
5. Stale-folder pruning (only the list the owner approved at Gate 1).
6. Data pipeline (test-first, extra care — data-critical).
After **each** batch: `node --check` touched files, boot on localhost:8000 with zero console
errors, **re-verify the standing anchors** (independently where calc code was touched),
checkpoint-commit, and **STOP for the owner's go** before the next batch.

**GATE (final) — Huge-file split PLAN (plan only, do NOT execute this round).** The owner
wants the big files (`graph.js`, `table.js`, `metrics.js`, `charts.js`, `styles.css`) split
into smaller modules **later**, in stages, using subagents. Produce a concrete **staged split
plan**: for each file, the proposed module boundaries, the stage order, the subagent roster
per stage (which agent/model owns which new file), the disjoint-file discipline, and the
verification per stage (anchors + browser pass). **Do NOT perform the splits in this project**
unless the owner explicitly approves executing them. Present the plan; STOP.

## Deliverables

1. **`review/CODEBASE_HEALTH_REPORT.md`** — the plain-English graded health report (Gate 1).
2. **The applied cleanup** — committed on `polish-b1-mechanical` (or a child branch) in
   per-batch commits, each anchor-verified, `main` untouched.
3. **`review/FILE_SPLIT_PLAN.md`** — the staged, subagent-based split plan for the huge files
   (plan only).
4. **A short plain-English closing summary** — what changed, the line/dead-code delta, what
   was deliberately left, and the recommended next step.

## Definition of done

- **Hard:** every touched `.js` passes `node --check`; the app boots on localhost:8000 with
  **zero console errors**; the **standing anchors reproduce exactly** on-screen and via
  independent DuckDB queries wherever calc-adjacent code was touched; a hands-on browser pass
  of the core flows (Filters → Search → table; Graph Builder; player popup; opposition/
  benchmark/radar) shows behaviour **identical** to before.
- **Measured:** net reduction in lines / dead code, reported as a concrete delta; no new
  behaviour introduced.
- **Human:** the owner reviews the Gate-1 report and each batch on localhost:8000 and signs
  off (budget ~15–30 min per gate). Merge to `main` is a separate owner decision, out of scope.
- **Red-flag (too-clean-is-wrong):** if ANY anchor number changes, or a flow behaves
  differently, STOP and revert — a health pass must never move a number or alter behaviour.
  A "cleanup" that changes output means calculation logic was touched.

## Iteration budget

This is **engineering, not research** — there is no metric to calibrate toward, so no
iteration cap is needed. The bound is the anchor/behaviour-preservation check after every
batch: it either reproduces exactly (proceed) or it doesn't (revert). The data-pipeline batch
is the one place to slow down: change test-first, and re-derive any affected anchor
independently from raw data before trusting it.

## Questions to ask the owner upfront (consolidated, before Gate 1 fixes)

- Confirm the **stale-folder prune list** once inventoried: which of `v1_pipeline/`,
  `v1_reference/`, `scratchpad/`, `debug/`, `analysis/`, `reference/`, `__pycache__/` are
  truly disposable vs. part of the owner's workflow. (`data/`/`source_data/` likely needed for
  local pipeline runs — confirm, don't delete blind.)
- Confirm cleanup lands on `polish-b1-mechanical` directly vs. a child branch.
- (Only if a latent-bug fix would change visible behaviour) surface it as its own decision.

## Non-goals

- **No new features, no UI redesign, no behaviour changes.** No changes to cricket
  calculations or displayed numbers.
- **No merge to `main`** (separate owner gate) and **no infra/CORS/deploy/README rewrites**
  unless the owner asks.
- **Huge-file splits are PLAN-ONLY this round** — execution is opt-in later.
- No adding a test framework/CI unless the owner requests it (note it as a recommendation if
  warranted, don't build it).

## Open questions / known unknowns

- Exact disposability of the stale folders (resolve via the upfront question, not assumption).
- Whether the pipeline is safe to run locally for verification, or must be reasoned about
  statically (the executor should determine this during inventory and say so).

## Decomposition hints (revisable with justification)

- **Gate 1 report:** top model (Opus), read-only, via `/opus-code-check`. One pass over the
  whole tree; delegate breadth-first file reading to cheap read-only sub-agents if helpful.
- **Fix batches:** run via `/opus-orchestrator`. Right-size each: dead-code/CSS removal and
  dedup are Sonnet-scale; correctness/pipeline batches are Opus-scale. ≤2 subagents concurrent,
  strictly disjoint files (and disjoint CSS regions), checkpoint-commit per batch, orchestrator
  verifies each batch in-browser against the anchors. Frontend and pipeline never in the same
  wave.
- **Split plan:** Opus, planning only — output `review/FILE_SPLIT_PLAN.md`, no code.
- Gate order is serial (report → owner → batch → owner → … → split plan). The report gates
  everything.
