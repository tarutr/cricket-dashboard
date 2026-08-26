# Post-launch feature beats — running log

Small, **standalone** features we deliberately parked before launch because they aren't essential to the core
product, each of which can ship **after launch as its own update** — a demand-driven release we can pair with a
short marketing video / changelog post to pull in new users. This is NOT the bug/tech backlog (`review/BACKLOG.md`)
and NOT rejected ideas — it's the "nice, not now, great launch-beat later" list. Owner-maintained; add to it
whenever a feature gets parked with a "add later if there's demand" disposition.

**Each entry:** what it does (plain English) · why it's parked · where it's tracked · is any of it already reachable
elsewhere today.

---

## 1. Leaderboard "Group rows / Split by"
- **What:** a small results-toolbar control that splits a player's single leaderboard line into several lines —
  one fully-aggregated stats line per value of a chosen dimension (e.g. Split by Opposition → SA Yadav becomes
  one row per opponent, each with its own inns/runs/avg/SR). Split-by options: opposition, batting position.
- **Why parked:** the same breakdown is already reachable per-player in the **player popup** (its Filters tab
  slices one player's record by value), so the leaderboard-wide version is a power-user convenience, not a gap.
  Was ruled "keep, tucked away" (decision 29), later removed during polish; owner reconfirmed 2026-08-26 it can
  wait.
- **Tracked:** decision 76.4 (2026-08-26). **Reachable today:** yes, per-player, via the player popup.

## 2. Nested condition groups ("Add Group")
- **What:** group filter conditions into nested brackets with their own AND/OR — e.g. *"(Australia **or** MCG)
  **and** Runs ≥ 50"* — instead of one global Match all / Match any across every condition.
- **Why parked:** the single global Match all/any covers the common cases; nested grouping is a smaller
  power-user need. The non-functional "+ Add Group" button is being removed for now.
- **Tracked:** decision 76.6 (2026-08-26). **Reachable today:** no (global Match all/any only).

---

*Add new beats above this line as they're parked. When one ships post-launch, move it to a "Shipped beats"
section with the release date so the log doubles as a changelog of demand-driven updates.*
