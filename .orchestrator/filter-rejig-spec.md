# Filter rejig — build spec (FILTERS ONLY)

> **Status: DESIGNED + owner-signed-off (2026-07-31). NOT built.** This is the complete redesign of the
> "+ Add condition" filter dropdown. Part of the post-ball-layer **filters/columns rejig**; owner sequence
> is **filters (this doc) → columns → columns-in-filters-popup → column presets (from scratch)**. Columns
> and presets are SEPARATE, LATER work — do not build them from this doc. Contract: `CLAUDE.md` (numbers
> sacred). Program context: `review/owner_decisions.md` decision 67 + this session's rulings; memory
> `ball-layer-program`, `feedback-uniform-filters`, `feedback-no-data-policing`.

## Principles the design rests on
- **Scope vs. metric.** A filter either *narrows who/what is in scope* (categorical) or *sets a bar on a
  number*. The delivery window (Ball Ranges) made a whole class of pre-baked "metric-in-a-window" filters
  redundant: "best powerplay SR" = **Ball Ranges: Phase=Powerplay + Batting Strike Rate**. So per-phase and
  progression metrics are DELETED as filters (they become columns later, in the columns rejig).
- **Sub-filters.** Families of same-axis variants collapse to ONE dropdown entry → pick variant → operator →
  value (`▸` below). ~60 flat metric rows → ~15 per discipline.
- **Niche is the audience — NEVER cut a filter for being niche.** Cut ONLY for genuine redundancy (reachable
  another way) or wrongness. See `feedback-no-data-policing`.
- **Numerals, not words** (50s not Fifties, Balls per 4, 5-WI). Names must be unambiguous about what the
  filter does (owner priority: clarity).

## THE FILTER DROPDOWN (final, in this order)

**Player Profile** — Playing role · Batting hand · Bowling style · Regular batting position · **PotM Count** · Team
- *Team* = the team the player represented in the counted matches (per-match), NOT "ever played for".
- *PotM Count* (added 2026-08-02) = **count of Player-of-the-Match awards** (`SUM` of the PotM flag; numbers-critical
  → independent-verify), a numeric filter (operator → value); placed after Regular batting position, before Team.
  NOT the old `MAX` "was PotM" indicator, which is NOT a filter.

**Match Details** — Opposition · Event (+Season) · Venue · Stage · **Match/Toss Result ▸**
- **Match/Toss Result ▸**: **Match** → Won/Lost/Drawn/Tied/No result **+ Condition** (Normal · Super Over ·
  D-L (rain) · VJD (rain) · Awarded · Fewer wickets) · **Toss** → Won/Lost · **Toss decision** → Batted
  first/Bowled first.

**— Batting —**
- **Basic Stats** — Matches · Innings · **Innings Number ▸** · Runs · Balls Faced · 4s · 6s ·
  **Dismissal Type ▸** · Ducks · Not Outs · High Score · 50s · 100s · **Innings Score ≥ N ▸**
- **Detailed Stats** — Batting Average · Batting Strike Rate · Balls per Dismissal · Boundary Ball % ·
  Boundary Run % · Dot % · NBSR · Percentage of Balls Faced · **Balls per… ▸** (Boundary/4/6) ·
  **% Runs in… ▸** (1s · 2s · 3s · 4s-boundary · 4s-run · 5s · 6s-boundary · 6s-run)

**— Bowling —**
- **Basic Stats** — Matches · Innings · **Innings Number ▸** · Overs · Balls · Maidens · Runs Conceded ·
  Wickets · **Wicket Types ▸** · Best Bowling · **Wicket Hauls ≥ N ▸**
- **Detailed Stats** — Bowling Average · Economy · Bowling Strike Rate · **Extras ▸** (wides/no-balls) ·
  Dot % · Boundary Run %

**Ball Ranges** *(the delivery window; built on Stats in Wave 3 UI-A as 4 separate entries — reorganise into
this group + rename)* — **Phase ▸** (Powerplay/Middle/Death; T20 & 50-over only) · **Over Range** ·
**Team Ball Range** (team legal balls; T20 & 50-over only) · **Batter/Bowler Ball Range ▸** (First/Last · N ·
faced [batting] / bowled [bowling]; all formats)

**Matchup (Vs)** *(men only — needs a profile)* — **vs bowling style ▸** (Pace · Spin · Off-spin · Leg-spin ·
Slow left-arm orthodox · Left-arm wrist-spin · Fast · Fast-medium · Medium-fast · Medium · Slow-medium ·
Uncategorised) · **vs batting hand ▸** (Right-hand bat · Left-hand bat · Uncategorised) · **Batting Position**
(the on-strike batter's position — own position batting view, faced batter's position bowling view)

**Fielding Stats** *(discipline-agnostic, own section)* — **Fielding Wicket Type ▸** (Caught · Run-out ·
Stumped) · **Wickets by Batting Position ▸** (position 1,2,3… of the dismissed batter)
- Fielding Stats = EXACTLY these two ▸ sub-filters — nothing else. Catches / Stumpings / Run-outs are NOT
  standalone entries; they = Fielding Wicket Type ▸ + a count operator (≥ N of that kind). No PotM here.
  **Owner 2026-08-02: Fielding Wicket Type keeps FOUR kinds — Caught · Caught & bowled · Run-out · Stumped.**

*Sub-filter mechanic (`▸`): one "+ Add condition" entry → secondary dropdown for the variant → operator
(is / at least / at most / between) → value.*

## Renames (old label → new)
Running Strike Rate → **NBSR** (Non-Boundary Strike Rate) · Strike Rate → **Batting Strike Rate** ·
Bowling Strike Rate stays but display **Bowling Strike Rate** (not "SR") · Economy Rate → **Economy** ·
Balls-Faced Share → **Percentage of Balls Faced** · Boundary % (batting) → **Boundary Ball %** ·
% Runs from Boundaries → **Boundary Run %** · Fifties/Hundreds → **50s/100s** · Balls per Four/Six →
**Balls per 4/6** · Four/Five-Wicket Hauls → **4-WI/5-WI** · Innings Order → **Innings Number** ·
Result → **Match/Toss Result** · Striker position → **Batting Position** · the "Fielding" fielding sub-filter
→ **Fielding Wicket Type** · Dismissed position → **Wickets by Batting Position** · "Out Caught/…" →
**Caught/…** (drop the "Out") · Ball range → **Team Ball Range** · Player balls → **Batter/Bowler Ball Range**.

## Deletes (redundancy or owner-cut only — NOT for niche)
- Per-phase Strike Rate / Economy / Wickets (Powerplay/Middle/Death + ODI variants), batting + bowling —
  subsumed by **Ball Ranges: Phase + the base metric**.
- Progression Strike Rate (first-10 / 11–20 / 21+) — subsumed by **Batter/Bowler Ball Range + Strike Rate**.
- **Wickets per Innings** — owner cut. **Not Out %** — owner cut. **Dismissals Effected** — re-summed
  (catches+stumpings+run-outs already filterable). **Boundary % Conceded** (balls-based bowling) — replaced
  by Boundary Run %. **Fielding-phase** & **Fielding-dismissal-kind** slices — covered by Fielding Wicket
  Type. (All parquet columns STAY; delete only from the filter pickers.)

## New metrics/filters to ADD (numbers-critical → data-engineer, test-first, independent verify)
All computable from ALREADY-STORED columns (ball engine reconstructs them; no pipeline needed):
- **Boundary Run %** (bowling): `(4·fours_conceded + 6·sixes_conceded)·100 / runs_conceded`.
- **Innings Score ≥ N** (batting): count of innings with per-innings runs ≥ N (sub-filter: N → count operator
  → value). The batting analog of Wicket Hauls.
- **Wicket Hauls ≥ N**: generalise the old exactly-4 / 5-plus to "count of innings with wickets ≥ N" for any N.
- **Extras** (bowling): wides / no-balls counts (from `wides_runs` / `noball_runs`), a sub-filter.
- **Innings Number** filter: `innings_number` = 1–2 (white ball) / 1–4 (red ball); discipline-aware (the
  innings the player batted / bowled in). Replaces the old batted-first/chased "Innings Order".
- **% Runs in…** expanded variants: 4s-run `(4·nb_fours)/runs`, 5s `(5·fives)/runs`, 6s-run `(6·nb_sixes)/runs`
  (from composition columns `nb_fours`, `nb_sixes`, `fives`), alongside the existing 1s/2s/3s and the boundary
  4s/6s.

## Build notes
- Label renames + regroupings are DISPLAY-ONLY (query builders byte-identical; anchors hold — numbers sacred).
- New metric defs are the only number-producing work; they are simple `sqlExpression`s over stored columns —
  verify each with an independent DuckDB check (decision-39 rule).
- UI: restructure the "+ Add condition" dropdown into the 7 groups above with the sub-filter mechanic;
  **Fielding Stats** becomes its own discipline-agnostic section; **Ball Ranges** = the already-built delivery
  window (Wave 3 UI-A four entries) reorganised + renamed.
- **Part B folds in here:** wire the Ball Ranges + Matchup + all filters into the Graphs filter popup and the
  player pop-up drawer (they only live on the Stats leaderboard today). Owner: no point redoing player
  filters twice, so do it in this rejig.

## Scope boundary / what's NEXT
FILTERS ONLY. Then, in order: **columns rejig** (incl. the by-phase breakdown columns which move here, not to
filters; and apply the same rename/numeral conventions) → **columns-in-filters-popup** (owner idea: a
"columns shown" section in the popup that mirrors the toolbar Columns dropdown, auto-minimised) →
**column presets** (from scratch, format × discipline).
