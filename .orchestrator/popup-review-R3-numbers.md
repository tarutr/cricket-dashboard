# Popup review R3 — independent number verification

**Purpose:** gate the ball-layer production cutover. Every headline figure below is
re-derived FROM SCRATCH off the RAW delivery base table (`deliveries_m_t20.parquet`) and
raw `fielding_events.parquet` per SPEC.md §4.1 — deliberately NOT reusing the app's
pre-aggregated `batting_innings` / `matchup_batting` files (decision-39 rule). The
pre-aggregated files are shown alongside ONLY as a drift cross-check (RAW must == PREAGG).

- **Script:** `.orchestrator/verify_popup_review_R3.py` (standalone Python-DuckDB, cwd = repo root)
- **Data source:** `data/wave1_out/` (same location the other `verify_wave*` scripts point at)
- **Scope (all checks):** Men / T20 / International, dates 2023-07-01 → 2026-07-02 (day-bounded); super overs excluded from raw
- **Result:** **ALL PASS — no drift.** No BLOCKER, no HIGH. One expected-NULL note on S3 (a correctness confirmation, not a defect).

## Independent definitions applied (§4.1)
- Batter runs = `SUM(runs_batter)`; balls faced = `COUNT(wides IS NULL)` (no-balls count as faced).
- Dismissals for average = wickets where `player_out_id` = batter, kind NOT IN {retired hurt, retired not out}; `retired out` counts. Built from a raw wickets relation = primary `wicket_kind`/`player_out_id` **UNION** unnested `wickets_extra[]` (multi-wicket balls). Verified `wickets_extra` is genuinely additive (4 rows in scope, none involving SA Yadav).
- Average = runs / NULLIF(dismissals,0); SR = runs*100 / NULLIF(balls,0) — div-by-zero → NULL.
- Innings = distinct (match_id, innings_number) in which the batter appears as striker (batter_id-only = 60 = full count, so no striker-less crease appearances for SKY).
- Per-innings slicing (S2/S3): re-derive each innings's own runs / balls / dismissed flag from raw, filter innings, then aggregate only the kept innings.
- Spin (S5) = raw deliveries JOIN `player_profiles` on `bowler_id`, `bowling_group='Spin'`.
- Fielding (S6) = raw `fielding_events`, `substitute IS NOT TRUE`; catches fold `caught` + `caught and bowled`; stumpings = `stumped`; run-outs = `run out`.

## Results

| # | Sample | Independent (RAW) | Anchor | Verdict |
|---|--------|-------------------|--------|---------|
| **S1** | SA Yadav — no filter | 60 inns / 1544 runs / 29.13 avg / 150.34 SR (dis 53, balls 1027) | 60 / 1544 / 29.13 / 150.34 | **PASS — anchor confirmed** |
| **S2** | SA Yadav — Innings Score ≥ 100 (his own runs) | 1 inn / 100 runs / 100.00 avg / 178.57 SR (dis 1, balls 56) | — (derived) | RAW == preagg |
| **S3** | SA Yadav — Not Out innings only | 7 inns / 366 runs / **avg NULL** / 163.39 SR (dis 0, balls 224) | — (derived) | RAW == preagg; avg NULL correct |
| **S4** | SA Yadav vs Opposition = Australia | 10 inns / 259 runs / 28.78 avg / 167.10 SR (dis 9, balls 155) | — (derived) | RAW == preagg |
| **S5** | SA Yadav vs Spin (matchup) | 38 inns / 454 runs / 322 balls / 140.99 SR | 38 / 454 / 140.99 | **PASS — anchor confirmed** |
| **S6** | JC Buttler fielding | catches 33 / stumpings 10 / run-outs 11 / total 54 | 33 / 10 / 11 / 54 | **PASS — anchor confirmed** |

### Notes for reconciliation against R2's on-screen reads
- **S2** = SA Yadav has exactly **one** personal century in-window (100 off 56, avg 100.00, SR 178.57). "Innings Score" in the pop-up filter is the **batter's own** innings runs (matches R2b `innings_score_ge` semantics), not the team total.
- **S3** = the **average must display blank/NULL** on screen (0 dismissals across the 7 not-out innings ⇒ div-by-zero ⇒ NULL per §4.1). If R2 shows a numeric average here, that is a drift to flag. SR 163.39 is well-defined.
- **S4** = Australia had data in-window (10 inns), so it was used as specified — no substitution needed. Note SKY has 9 dismissals across 10 Australia innings (1 not-out).
- **S5** coverage reconciles: 913 mapped balls = 591 pace + 322 spin, of 1027 total balls faced (114 unmapped) — matches the CLAUDE.md coverage note "913 of 1,027".
- **S6** Buttler has 0 substitute rows and 0 `caught and bowled` (expected for a keeper); catches = 33 pure `caught`. Total 54 = 33 + 10 + 11.

**Every anchor (S1, S5, S6) was reproduced by an independent query, and every RAW-vs-preagg
cross-check held (S1–S5). No calculation drift detected between the raw delivery base table
and the app's pre-aggregated files.**
