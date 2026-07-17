# Orchestration rules for cricdb

Distilled from the owner's `/opus-orchestrator` skill so the discipline holds in ANY session —
with or without the skill, on any model. `CLAUDE.md` is the supreme contract; this file governs
how multi-agent work is run. The live phase plan is `.orchestrator/design-plan.md`;
`.orchestrator/plan.md` is a signpost stub kept for the skill's entry path.

## The loop

1. **Understand** — restate the goal + definition of done; surface ALL owner questions up front
   in one consolidated batch, not dribbled through the run.
2. **Plan** — write the wave/task breakdown into `design-plan.md` (tasks sized so one agent
   finishes one task in one run; disjoint file ownership for anything parallel).
3. **Assign model + effort per task BEFORE spawning** (table below). Never spawn without an
   explicit `model`.
4. **Spawn + manage** — orchestrator writes no feature code while workers run; verify every
   "done" independently (run the checks yourself / read the diff — never trust the report alone).
5. **Review** — number-adjacent work gets the orchestrator's own independent DuckDB check;
   a fresh-context reviewer reads the whole diff at the end of a round.

**Gates:** work in waves; after each wave: verify in-browser against the anchors, commit,
**STOP for the owner's go**. Merging to `main` is always a separate owner decision.

## Model / effort routing

| Task nature | Model / effort |
|---|---|
| Read-only search, file inventory | Haiku / medium (read-only tools) |
| Boilerplate, mechanical edits, renames, config, doc updates | Haiku or Sonnet / medium |
| Standard feature work on established patterns; CSS/styling passes | Sonnet / high |
| Novel logic, cross-cutting refactors, debugging unknowns | Opus / high |
| Cricket-correctness-critical SQL, architecture-touching, matchup-query work | Opus / xhigh |
| Final fresh-eyes review of a round | Opus / xhigh, fresh context |

- Bias cheaper + tighter spec when in doubt; **never start two tiers up "to be safe"**.
- Escalation ladder: 1st failure → rewrite the spec tighter, retry same tier; 2nd → up one
  model tier or effort level; 3rd → orchestrator takes it inline and notes it.
- Project agents (`.claude/agents/`): scaffolder=Haiku, frontend-engineer & design-stylist=Sonnet,
  data-engineer & frontend-heavy=Opus. **GOTCHA:** resuming an agent via SendMessage reverts it
  to its pinned frontmatter model — a spawn-time `model` override does NOT survive the resume.
  For higher-tier work, spawn fresh (or use the heavy variant); don't resume across tiers.

## Worker briefs (every spawn, no exceptions)

Workers know nothing about the conversation. Every brief contains:
1. TASK — one tightly-scoped task; point at the plan file for shared context.
2. FILES YOU OWN / FILES YOU MUST NOT TOUCH (parallel workers = disjoint files).
3. ACCEPTANCE CRITERIA + the exact verification commands to run before reporting.
4. SCOPE — per CLAUDE.md Rule 2: owner decisions are law; defects are fair game
   ("Also fixed" for small inline fixes, "Suggestions (not built)" for everything else).
5. CHECKPOINT DISCIPLINE — commit `wip:` after each meaningful unit (~20 min max uncommitted);
   append a short note to `.orchestrator/progress/<task>.md` (done / next / gotchas).

**Report format:** WHAT CHANGED (files + one line each) / VERIFIED (commands + actual results,
anchors included) / ALSO FIXED / SUGGESTIONS (not built) / CONCERNS.
**Never claim done with failing verification — report BLOCKED with the failure output.**

## Resume protocol (session died mid-run)

Do NOT respawn from scratch. First audit what survived: `design-plan.md` statuses, `git log`
since the last gate, every file in `.orchestrator/progress/`. Update the plan to match reality
on disk, then respawn only unfinished tasks, pointing each new worker at its predecessor's
progress note + last `wip:` commit with instructions to verify that state and continue.

## Decision hygiene

- Owner rulings are appended to `review/owner_decisions.md` (the ONLY decision log) at each gate.
- `design-plan.md` tracks wave status and references decisions — it does not re-narrate them.
- The orchestrator's briefs and gate reports carry a **scope check**: built exactly what was
  asked, deltas called out explicitly, adjacent ideas surfaced as questions — never built on
  the strength of "consistency" or "symmetry".
