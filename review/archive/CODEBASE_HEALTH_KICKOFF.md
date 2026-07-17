# Kickoff prompt — paste this into the new session

You are the orchestrator for a whole-codebase **health & cleanup** pass on the cricdb project
at `/Users/tarutr/Desktop/live_db` (branch `polish-b1-mechanical`; `main` is production — do
not touch it, and do not merge).

**Read these two files first, in full, before doing anything else:**
1. `review/CODEBASE_HEALTH_SPEC.md` — the full brief (goal, the sacred standing-anchor numbers,
   known debt, phase gates, definition of done, non-goals). It is self-contained and
   authoritative.
2. `.orchestrator/plan.md` — the build history and accumulated-debt notes.

I am the owner and I am **not a coder** — I rely on you to break this down. Explain everything
to me in plain English (name the file and what changed and why it's safe, never raw diffs).

Non-negotiable: this is a cleanup, **not** a behaviour or feature change. The app must do
exactly what it does now and show exactly the same cricket numbers. The spec lists standing
anchor numbers (e.g. 2,813 batting / 2,049 bowling; SA Yadav 60/1,544/29.13/150.34 with the
date range 2023-07-01→2026-07-02) — treat them as a tripwire: if any of them move, you touched
calculation logic and must revert.

**Work report-first, in gated batches.** Start with **Gate 1 only**: do a read-only
whole-codebase health review (use the `/opus-code-check` skill), covering the website app, the
Python data pipeline, and stale/leftover folders. Produce a plain-English graded report saved
to `review/CODEBASE_HEALTH_REPORT.md` — findings by severity, each with why it's safe or risky
to fix, plus a proposed batch plan and a stale-folder prune list (as a proposal). **Then STOP
and present it to me. Do not edit any code until I approve the plan.**

After I approve, fix in small reviewable batches (the spec's suggested order): dead code →
duplication → efficiency → safe latent-bug fixes → stale-folder pruning → data pipeline
(test-first). Use right-sized sub-agents, ≤2 at a time on disjoint files, checkpoint-commit
each batch, and after every batch re-verify the anchors on localhost:8000 (start it with
`python3 -m http.server 8000`) and **stop for my go** before the next.

Separately, produce a **plan only** (no execution this round) for splitting the huge files
(graph.js, table.js, metrics.js, charts.js, styles.css) into smaller modules — staged, with a
sub-agent roster and per-stage verification — saved to `review/FILE_SPLIT_PLAN.md`.

Confirm the stale-folder prune list with me before deleting anything, and tell me if a
latent-bug fix would change something I'd see on screen (that's my decision, not a silent fix).
