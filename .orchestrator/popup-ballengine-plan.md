# Player pop-up on the ball engine → Tab-2 "Filters" table (design SIGNED OFF 2026-08-03)

> Sub-program of the ball-layer ([[ball-layer-program]]); on branch `ball-layer`, flag-gated (`?engine=ball`); the
> pop-up cuts over WITH the ball layer, not before. Contract: `CLAUDE.md` (numbers sacred; Rule 3 —
> ask-before-building). **Design is signed off; no build past the T0 gate until a working mock is approved.**

## Goal
The player pop-up on the ball engine as its single source of truth (P0/P1 DONE — the pop-up already computes
every section from balls byte-identical + has a player-scoped fast path). Build **Tab 2 — "Filters"**, a
slice-comparison table for one player. **Tab 1 ("Overview" / base profile) stays UNCHANGED.**

## Tab 2 "Filters" — the signed-off design
A second tab: a table where **each ROW is a user-defined filtered slice of THAT ONE player's record** — a
mini-leaderboard where rows are slices instead of players. Add / edit / remove rows. Reads "SR when scoring 100+
vs SR when ≤120" as two rows side by side.

**Per-row filter**
- Each row's filter = the **full advanced-filters palette**; a single row can **combine multiple conditions**.
- The per-row editor **IS the real main-popup Advanced-Filters flow**: `+ Add condition` → pick filter → metric /
  operator / value → add another → **Search** commits the row. Editing a row reopens it pre-filled.
- **Reading A**: any metric definable for one innings can slice (Runs / SR / 6s yes; Average, Balls-per-Dismissal,
  ratios, multi-innings aggregates no).
- Palette in the pop-up **drops the fixed Player Profile filters** (Playing role · Batting hand · Bowling style ·
  Regular batting position) **and PotM Count** (filter only — see Columns), keeping only **Team**. Matchup filters
  (vs bowling style · vs batting hand · vs opponent player) STAY (they're about the opponent). Per-context config
  on the SHARED palette — the main leaderboard keeps them all.

**Scope**
- Tab 2 has its **own scope control, INSIDE a filters popup** (opened from a Filters button) — like the leaderboard
  popup, **not laid out inline** in the tab. Scope = leaderboard Search Conditions **minus Gender** (player fixes
  it): **Discipline · Format · Team type · Date range**. Use the REAL controls (Format = Red Ball / 50 Over / T20;
  Team type = International / Domestic — there is NO "T20 International"; that was a mock hallucination).
- **Discipline is per-tab** (Tab 1 header; Tab 2 inside its scope popup) — this removes the shared-header toggle
  that overlapped the [×]. Converting Discipline to a dropdown everywhere is a **LATER wave, not Tab 2** — Tab 2
  uses the current shared control.

**The table**
- **Columns = the real shared leaderboard column picker + presets** — reuse the SHARED component, not a copy, so
  the later columns rejig flows into Tab 2 automatically. Columns are NOT decided in this program (that's the
  columns rejig). PotM Count remains a column via that shared picker; it is dropped only as a *filter*.
- **Row identity (first cell)** = the row's FIRST filter as plain TEXT (leaderboard-style, like the player-name
  column). If a row has >1 filter, an **(i) reveals the COMPLETE filter list, including the one used as the name**,
  on hover. **No pills.**
- **Edit = a pencil icon** (not the word); **edit + ✕ (delete row) inline with the first-column text**, not on a
  line below. Lean; small, tight buttons; conforms to the dashboard design system.
- **Sort:** default = order rows were added; user can column-sort or **pin** rows — SAME as the leaderboard. **No**
  Best/Worst highlighting. **No** pinned baseline row (user adds what they want — the point of a separate tab).

**New filter — opponent-player**
- "Player X vs a specific opponent Y" (head-to-head), on the ball engine (`bowler_id` when batting / `batter_id`
  when bowling); a player-search picker in the Matchup group. Added to **Tab 2 AND the main leaderboard**.

**BUILD PRINCIPLE (the hard lesson of this design phase)**
- Build **off the REAL components** — the real advanced-filters palette, the real scope controls, the real column
  picker/presets. Every hand-built mock this phase HALLUCINATED (invented "T20 International", wrong Match Result,
  invented dropdown-nesting). The real palette already does Match/Toss Result → its real "Condition" add-on with no
  invented nesting. Do NOT re-create these; import/reuse them.

## Guardrails
Numbers sacred — a NO-FILTER row == the player's full-scope record (byte-identical); every sliced row
independently DuckDB-verified; leaderboard anchors unchanged (2,813 / Karanbir 2,454 / SKY 60·1,544·29.13·150.34).
Flag-gated; NO cutover in this program. Design sign-off before build (Rule 3).

## Waves
- **P0 — Map / anchor / design.** ✅ DONE + verified (`.orchestrator/progress/popup-P0.md`).
- **P1 — Core sections on the ball engine, byte-identical.** ✅ DONE + verified (`b942be1`; ZERO src changes — the
  pop-up already runs on balls + has the player-scoped fast path; SA Yadav + Sikandar Raza sections all exact).
- **T0 — working mock off the REAL components** *(sign-off gate; no production code — read-only reuse of real
  components).* ⛔ **STUCK — not yet achieved.** Hand-built mocks hallucinated; the real-component preview harness
  (`.orchestrator/dropdown-preview.html`) hung at DB init AND was wrong-scoped (leaderboard drawer, not the Tab-2
  pop-up). Next: a mock that reliably renders the real palette + scope + columns in the Tab-2 layout → owner approves.
- **T1 — Opponent-player filter (ball engine)** *(data-engineer, Opus)*. "X vs opponent Y" delivery filter;
  independent-verify a head-to-head; add to the SHARED palette (main leaderboard + Tab 2). Standalone win.
- **T2 — Tab 2 table** *(frontend-heavy, Opus)*. The tab + rows (add/edit/remove) + per-row multi-condition
  editor (real advanced-filters flow) + scope-in-popup + shared column picker/presets + per-row player-scoped
  ball-engine query. Verify: no-filter row == full player; sliced rows correct; "100+ vs ≤120" as two rows.
- **T3 — Fielding filters + columns** *(data-engineer, Opus)*. Fielding source so Fielding Wicket Type ▸ / Wickets
  by Batting Position work + fielding columns.
- **T4 — Perf + integrated review** *(Opus)*. Per-row query perf (reuse ball-layer caching); fresh-eyes review;
  anchors; cutover-ready.

## Sequencing (owner-confirmed 2026-08-03)
The player pop-up is the ACTIVE thread and **continues first**; the columns rejig comes AFTER (owner's order). No
reorder is needed: Tab 2 reuses the shared column component, so the later columns rejig flows into it
automatically. (An earlier draft wrongly put columns first — retracted.)

## Status
P0 ✅ / P1 ✅ verified. **Tab-2 design SIGNED OFF (2026-08-03).** ⛔ **STUCK on T0 — no accepted mock yet.** Restart
here: produce a working mock off the real components (per the BUILD PRINCIPLE above) → owner approval → T1 → T2 →
T3 → T4. Nothing past T0 builds without owner sign-off.
