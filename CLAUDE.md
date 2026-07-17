# cricdb — working agreement (auto-loaded; read before anything else)

Cricket stats explorer (Men + Women): static browser app, plain ES modules, no framework,
no build step; DuckDB-WASM queries Parquet on Cloudflare R2. The owner is **non-technical**:
report in plain English, name the control and what changed — never raw diffs.

## Rule 1 — Numbers are sacred

You change only WHEN and HOW things display, never WHAT a query returns. The query builders —
`buildQuery` / `buildMatchupQuery` in `src/table.js`, `buildScopeClauses` in `src/filters.js` —
stay byte-identical unless the task explicitly authorizes a query change.

**Standing anchors** (scope Men / T20 / International, dates 2023-07-01 → 2026-07-02, day-bounded):

| Anchor | Value |
|---|---|
| Batting baseline | **2,813 players**; top row Karanbir Singh **2,454** runs |
| SA Yadav | **60 inns / 1,544 runs / 29.13 avg / 150.34 SR** |
| Matchup (bowling) | Bumrah vs RHB, striker positions 1–2 = **27 inns / 177 balls / 9 wkts** |
| Matchup (batting) | SA Yadav vs Spin = **38 inns / 454 runs / SR 140.99**, coverage 913 of 1,027 |

If any anchor moves, you touched calculation logic — **revert**. DuckDB-WASM returns SUM
aggregates as BigInt → wrap in `Number()` before comparing.

## Rule 2 — Owner decisions are law; defects are fair game

- Anything the owner has explicitly ruled (a behaviour, a UX semantic, a scope choice) must
  never be reversed, extended, or "improved" — even when you are sure it would be better.
  If your task seems to require it, or you believe the ruling is wrong: **stop and report**.
- Real defects you trip over while working (bugs, crashes, dead code, typos, a broken check):
  fix small ones inline and list them in your report under **"Also fixed"**. Anything bigger,
  or anything touching ruled-on behaviour, goes under **"Suggestions (not built)"**.
- Orchestrators: every behavioural item in a subagent brief must trace to a sentence the owner
  actually said; anything untraceable becomes a question to the owner, not part of the brief.
  Subagents: if your brief appears to exceed the owner's stated intent, flag it in your report.

## Verification ritual (every change)

- Serve on **http://localhost:8000** (`python3 -m http.server 8000`). R2 CORS allows only
  `localhost:8000` / `127.0.0.1:8000` — no other port/host loads data.
- Browsers cache ES modules hard: after editing, `fetch(path, {cache:'reload'})` each changed
  file, then reload. If the automated browser pane reports a 0×0 viewport, resize to 1280×800.
- `node --check` every touched `.js`; boot with **zero console errors**; reproduce the anchors
  on screen.
- Number-adjacent changes get an **independent hand-written DuckDB check**
  (`import('/src/db.js').then(m => m.query('SELECT …'))`) — never reuse the app's own
  aggregation shape to verify itself.

## Where things live (pointers, not copies — do not duplicate content across files)

- Product + cricket calculation rules: `SPEC.md` (§4.1 is calculation law), `SPEC_ADDENDUM_DATA.md`
- Decision log (**the only one**): `review/owner_decisions.md`
- Orchestration rules (models, effort, waves, reports, resume): `.orchestrator/ORCHESTRATION.md`
- Live phase plan + wave status: `.orchestrator/design-plan.md`; per-task notes: `.orchestrator/progress/`
- Data schema: `reference/db_reference.md`; chart system: `reference/CHART_SYSTEM.md`
