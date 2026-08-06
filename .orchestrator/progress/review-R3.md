# Progress — review-R3 (independent number verification, popup review)

## 2026-08-06 — R3 complete, ALL PASS

Independent re-derivation of the fixed pop-up sample set (S1–S6), read-only (nothing under
`src/` touched). Scope: Men / T20 / International, 2023-07-01 → 2026-07-02 (day-bounded).

- **Script:** `.orchestrator/verify_popup_review_R3.py` — standalone Python-DuckDB, reads
  `data/wave1_out/` (same source as `verify_waveR2*.py`). Headline figures derived from the
  RAW `deliveries_m_t20.parquet` + raw `fielding_events.parquet` per §4.1, NOT the app's
  pre-aggregated files (decision-39). Pre-agg files used only as a drift cross-check.
- **Summary doc:** `.orchestrator/popup-review-R3-numbers.md`.

**Verdict: ALL PASS — no calculation drift. No BLOCKER / HIGH.**

- S1 SA Yadav no-filter → 60 / 1544 / 29.13 / 150.34 — **anchor confirmed** (dis 53, balls 1027).
- S2 Innings Score ≥ 100 → 1 inn / 100 / 100.00 / 178.57 (one century in-window). RAW==preagg.
- S3 Not Out only → 7 inns / 366 / **avg NULL** / 163.39. avg NULL is correct (0 dismissals ⇒
  div-by-zero ⇒ NULL). RAW==preagg. Reconcile: on-screen avg must be blank.
- S4 vs Australia → 10 inns / 259 / 28.78 / 167.10 (Australia had data; no substitution). RAW==preagg.
- S5 vs Spin → 38 / 454 / 322 balls / 140.99 — **anchor confirmed** (raw+profiles bowling_group='Spin').
  Coverage 913 mapped (591 pace + 322 spin) of 1027 total — matches the CLAUDE.md note.
- S6 JC Buttler fielding → catches 33 / stumpings 10 / run-outs 11 / total 54 — **anchor confirmed**
  (0 substitute rows, 0 c&b, pure caught 33).

Confirmed independently along the way: `wickets_extra` is additive (not a duplicate of the
primary wicket); SA Yadav appears as striker in all 60 innings (no striker-less appearances).
