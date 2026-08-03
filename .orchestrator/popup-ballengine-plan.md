# Player pop-up on the ball engine → Tab-2 "Filters" table (design SIGNED OFF 2026-08-03)

> Sub-program of the ball-layer ([[ball-layer-program]]); on branch `ball-layer`, flag-gated (`?engine=ball`); the
> pop-up cuts over WITH the ball layer, not before. Contract: `CLAUDE.md` (numbers sacred; Rule 3 —
> ask-before-building). **Design is signed off; no build past the T0 gate until a working mock is approved.**

## Goal
The player pop-up on the ball engine as its single source of truth (P0/P1 DONE — the pop-up already computes
every section from balls byte-identical + has a player-scoped fast path). Build **Tab 2 — "Filters"**, a
row-comparison table for one player. **Tab 1 ("Overview" / base profile) stays UNCHANGED in content** — but the
old **"Player Filters" overlay is RETIRED** (owner 2026-08-03): the new tab-system replaces it, so Overview
becomes the always-full-scope base profile and ALL filtering lives in Tab 2. Build plan + waves + model/effort:
`.orchestrator/popup-tab2-build-plan.md`.

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

**Scope — Format / Team type / Date are PER ROW; Discipline is SHARED per-tab (revised 2026-08-03; supersedes the earlier shared/tab-wide scope design)**
- There is **NO separate scope / "Filters" popup and no tab-level Filters button.** Each row's **Format · Team
  type · Date range** live **inside that row's Add Filter Row popup**, alongside its `+ Add condition` filters —
  so **every row is self-contained on those three** (Row 1 could be Format = T20, dates 2023–24; Row 2
  Format = Test, all dates). Per-row scope = leaderboard Search Conditions **minus Gender** (player fixes it)
  **and minus Discipline**. REAL controls (Format = Red Ball / 50 Over / T20; Team type = International /
  Domestic — there is NO "T20 International").
- **Discipline is SHARED for the whole tab (owner 2026-08-03 — NOT per-row):** the table is all-batting OR
  all-bowling; a single table NEVER mixes batting and bowling rows. Reason: **column-name standardisation** —
  mixed disciplines would confuse the shared column set. Discipline is a tab-level control (like the
  leaderboard's); its exact placement is a layout detail to SHOW in the T0 mock, not decided abstractly.
- **Sticky default (owner 2026-08-03):** a new Add Filter Row popup pre-fills its Format / Team type / Date with
  **the last row that was added**, so the user doesn't re-pick them every time.

**The table**
- **Columns = the real shared leaderboard column picker + presets** — reuse the SHARED component, not a copy, so
  the later columns rejig flows into Tab 2 automatically. Columns are NOT decided in this program (that's the
  columns rejig). PotM Count remains a column via that shared picker; it is dropped only as a *filter*.
- **Row identity (first cell)** = the row's FIRST filter as plain TEXT in **LITERAL operator form** (e.g.
  `Innings Score ≥ 100` verbatim — no friendly paraphrase), leaderboard-style, like the player-name column. If a
  row has >1 filter, an **(i) reveals the COMPLETE filter list (bare list, no header), including the one used as
  the name**, on hover. **No pills.**
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

## Terminology (owner-confirmed 2026-08-03 — labels final)
- **"Add Filter Row"** — standardised on BOTH buttons: the tab button that opens the editor AND the commit button
  inside the editor (NOT "Search", NOT "Add Row"). Edit mode (opened via the pencil): title reads **"Edit Filter
  Row"**, commit button reads **"Save"** (assumption — confirm if it too should read "Add Filter Row").
- **Edit = a pencil icon** (never the word "Edit") + **[✕]** delete, both inline with the row-title text (first cell).
- **Row label = the row's first condition in LITERAL operator form** (e.g. `Innings Score ≥ 100`); **(i)** reveals
  the full condition list (bare, no header) when a row has >1 condition.
- **Empty state = "No filtered rows yet"** (pairs with the "Add Filter Row" button).
- **"slice" is BANNED from all user-facing text** — say "row" / "filtered row". It survives ONLY as internal
  shorthand in these planning docs. (Owner has asked twice; see memory `feedback-retire-slice-word`.)

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
P0 ✅ / P1 ✅ verified. **Tab-2 design FULLY FINALISED (2026-08-03)** — terminology (see Terminology section), per-row
scope for Format / Team type / Date, Discipline shared per-tab (see the revised Scope section); **no open design
questions remain.** ⛔ **STUCK on T0 — no accepted mock yet.** Next: produce a working mock off the real components
(per the BUILD PRINCIPLE above) → owner approval → T1 → T2 → T3 → T4. Nothing past T0 builds without owner sign-off.
