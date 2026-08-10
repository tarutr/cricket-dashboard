# Fielding Composers — build plan (owner-signed-off design, 2026-08-10)

> NEW feature, BEYOND the R0–R6 columns reconciliation (which is done + awaiting the owner's live review). Independent
> of that review. Contract: CLAUDE.md (numbers sacred — `buildFieldingCteSql` is SACRED; §4.1). Design pinned with the
> owner in chat 2026-08-10.

## PINNED DESIGN
A fielding composer = **pick a base tally + a dimension + tick the values → each becomes its own column**, with a
**count ↔ per-match toggle**. On BOTH surfaces (leaderboard + player pop-up).

- **Base tallies (5):** Catches · Stumpings · Run-outs · Caught & Bowled · **Fielding Dismissals (all types)**.
- **Dimensions (6):** Phase (PP/Mid/Death) · Over Range (user-defined) · Innings Number (1st/2nd + red-ball 3rd/4th) ·
  Dismissed batter's Position (**granular, user-defined ranges** 1–2 / 3–6 / 7 …, NOT fixed buckets) · Dismissed
  batter's Hand (L/R) · Bowler Style (pace/spin/detailed).
- **DROPPED:** dismissed batter's Role — not a composer dimension on either surface (owner). The existing role FILTER
  (`out_role`) is UNTOUCHED (separate feature; confirm if owner wanted it removed too — currently NOT in scope).
- **NOT composers — scope FILTERS (both surfaces):** Opposition · Venue · Event · Season · City · Stage · Result ·
  Toss · Team · specific batter · specific bowler. (Narrow to a value; every column reflects it — "catches vs India in
  2025" = opposition+season filters, not columns.)
- Data check DONE: `fielding_events` carries phase / out_batting_position (1–11) / out_hand / bowler_style / over /
  innings — all present (the pop-up's fielding FILTERS already read them). Match context via the `matches` join.

## BUILD — 2 waves, sequential (SQL foundation → UI both surfaces)

### FC-1 — Fielding-composer SQL + key scheme — **data-engineer (Opus), numbers-critical**
- Composed-key scheme for (tally × dimension × value/range), resolved by `getMetric` like the other composed families
  (isr__/wh__/ph__…): e.g. `fc__catches__phase__pp`, `fc__runouts__pos__1_2`, `fc__dismissals__over__1_6`.
- Each column's sqlExpression = a `SUM(CASE WHEN <dimension matches value/range> AND <tally condition> THEN 1 END)`
  over the EVENT-grain `fielding_events` view. NOTE: unlike the batting/bowling composers (which recombine
  pre-materialised innings components), fielding has NO pre-materialised per-dimension components — this is a FRESH
  event-grain aggregation, so it's genuinely new SQL. Handle granular user-defined position + over ranges; phase;
  innings; hand; bowler-style. Per-match toggle = the composed count ÷ matches.
- ADDITIVE + sacred-safe: the existing fielding tallies and `buildFieldingCteSql`'s current behaviour stay
  byte-identical; composes with the scope filters (opposition/venue/season via the `matches` join) AND the pop-up's
  per-innings/scope slicing.
- VERIFY: independent hand-written DuckDB per composed column (each = a raw event count), a per-match case, a granular
  position-range case; ALL standing anchors byte-identical (2,813 / Karanbir 2,454 / SA Yadav 60·1,544·29.13·150.34 +
  matchup 27·177·9 / 38·454·140.99 — fielding composers are additive, none of these move).

### FC-2 — Fielding-composer UI, both surfaces — **frontend-heavy (Opus)** (after FC-1 verified)
- **Leaderboard:** add the 6 composer entries (Phase / Over Range / Innings / Dismissed Position / Dismissed Hand /
  Bowler Style) to the Fielding dropdown in the columns picker; each opens the R4-A compose editor (pick tally + tick
  dimension values → standalone full-control rows), count/per-match toggle. Fielding is a column-family added onto a
  batting/bowling table there.
- **Pop-up:** give the Fielding MODE a filter-style picker for the FIRST time (today it's a fixed 6-tally table with no
  picker) — base tallies + the 6 composers, chosen-rows + controls, matching the R5 pattern. Convert the fixed
  `FIELDING_COLUMN_KEYS` to a Slot[] model. `columnsPicker.js` is SHARED — keep the leaderboard byte-identical (gate
  any change like R5's `ownDisciplineOnly`).
- Wires to FC-1's keys/resolver; NO query change here. Anchors byte-identical; leaderboard + pop-up base-tally numbers
  unchanged.

## VERIFY (each wave) + PROCESS
node --check; 0 console errors; anchors byte-identical (plain + matchup); FC-1 independent DuckDB; FC-2 live on both
surfaces (composers render + compute; the pop-up Fielding mode now has a working picker). Sacred `buildFieldingCteSql`
behaviour unchanged. Orchestrator reviews the diff + commits each wave (builders: NO git, NO foreground server,
STOP-RULE on any ambiguity). Nothing pushed (ships at the cut).

## OWNER RULING — Bowler Style dimension (2026-08-10, mid-build, during FC-1)
FC-1 built 5 of the 6 dims; the 6th (Bowler Style) hit a STOP-RULE: `fielding_events.bowler_style` carries the RAW
Cricsheet style (e.g. "Right-arm offbreak", "Left-arm slow"), NOT the normalised Pace/Spin/detailed grouping the
matchup "vs Spin" uses (`bowling_group`/`bowling_type`, which live only on the matchup views). **Owner ruled: ADD the
grouping to the fielding data** — i.e. add `bowling_group` (Pace/Spin) + `bowling_type` (detailed) to the
`fielding_events` export in `export_parquet.py`, reusing the EXACT same classification the matchup surface already uses
(no new cricket logic), so fielding Bowler Style == matchup grouping byte-for-byte and works cross-gender. Accepted
trade-off: Bowler Style can't be verified LIVE until the data pipeline re-runs (owner-triggered) and re-uploads the
parquet to R2 — so it sits OUT of the imminent live review; the other 5 dims are in it. ⇒ NEW wave **FC-1b**
(data-engineer): the export columns + extend the reserved `bstyle` resolver branch onto them. Then FC-2 builds the UI
for all 6 dims at once (bstyle renders; computes once the parquet lands).
