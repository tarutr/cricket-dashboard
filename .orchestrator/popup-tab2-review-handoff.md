# Player pop-up Tab-2 "Filters" — HANDOFF for the OVERALL REVIEW (fresh session)

> Written 2026-08-03 at the end of the build session. The **entire tab is built + committed on
> `ball-layer`** (nothing pushed). The owner wants the **overall pop-up review done in a NEW session**.
> This doc is that session's starting point. Contract: `CLAUDE.md` — numbers sacred (Rule 1), owner
> decisions law (Rule 2), ask-before-building (Rule 3). Authoritative build tracker:
> `.orchestrator/popup-tab2-build-plan.md`; design: `.orchestrator/popup-ballengine-plan.md`;
> decision log: `review/owner_decisions.md` #70.

## What's DONE (all committed on `ball-layer`, flag-gated content behind `?engine=ball`)
The player pop-up's **Tab 2 "Filters"** — a per-player table where each ROW is a filtered slice of that
one player's record — is complete. Built on the leaderboard's own `buildQuery`/`buildMatchupQuery`
(UNCHANGED — numbers sacred), scoped per-player via the precedented outer-wrap idiom.

| Wave | What | Commit |
|---|---|---|
| Wave A | tab scaffold; old "Player Filters" overlay RETIRED; shared `columnsPicker.js` + `paletteGroups.js` extracted | `116e90a` `57892d2` `770c5e3` |
| T-1 | opponent-player filter (ball engine; leaderboard + tab); men-only note removed | `ab642e7` `dbf9e84` |
| T-2a | per-row data path (clone scope → buildQuery → outer-wrap `WHERE id`) | `10d4cd2` |
| T-2b-i | **per-innings SLICING engine** — conditions = per-innings WHERE (additive `opts.inningsWhere`, byte-identical for 2-arg callers); **PotM (Y/N)**; per-row window/opponent threading | `e95dc1d` |
| T-2b-ii | interactive editor (real Add-condition palette, sticky per-row scope, edit/delete/sort/pin) | `d719b63` |
| T-2c | scope singletons (Opposition/Event/Venue/Stage/Result/Toss/Innings Number/Team) + opponent/window editors + UX (discipline reset+warning; "Add Filter Row" both buttons) | `99a959d` |
| T-2d | Matches-column fix (opponent/window rows → COUNT DISTINCT match_id, additive `opts.inningsMatches`) | `58279ca` |
| T-2e | matchup Vs (Option A — routes through `buildMatchupQuery`, leaderboard-identical) + batting-position list | `c39ab52` |
| T-3a / T-3a-ext | fielding-mode query engine (reuses sacred fielding CTE) + full fielding filter set + matches-join + reusable `loadDimOptions` | `4c7ce94` `f3713cf` |
| T-3b | fielding UI (Filters-tab-only mode, dedicated `playerFieldingEditor.js`, data-driven gating) | `aa38481` |
| retrofit | **data-driven filter availability** — removed ALL men-only offer-path hardcode (`filterAvailability.js`); men see filters, women auto-hidden, auto-appear when women's data lands | `cac8dfe` |

**Filter set:** per-innings amounts/rates/thresholds; Y/N (Ducks, Not Outs, dismissal-type, PotM);
scope (Opposition, Event, Venue, Stage, Match Result, Toss, Innings Number, Team); Matchup Vs (vs
bowling style/hand, batting position, vs opponent player — Option A, leaderboard-identical); ball-range
window; and a **Fielding mode** (Filters-tab-only) with the full fielding filter set + tally columns.
**Availability is DATA-DRIVEN everywhere** — no gender hardcode in the offer path.

## How to verify (for the review)
- Serve `localhost:8000`; R2 CORS allows only `localhost:8000`/`127.0.0.1:8000`. `fetch(cache:'reload')` changed modules.
- **Most of the tab works FLAG-OFF against production R2** (`buildQuery`/`buildMatchupQuery`/`fielding_events`/`matches`/`profiles` are all on R2) — that's how it was verified (full real data; the numbers are byte-identical flag-on because the ball engine reconstructs the same views).
- **Ball-engine-only bits** (opponent-player, ball-range window) need `?engine=ball` + the LOCAL ball snapshot (see `.orchestrator/progress/tab2-T1-opponent-filter.md`; note Python 3.14 `http.server` lacks Range/206 → use a range server; ALWAYS revert config.js after).
- Anchors (must hold): 2,813 players / Karanbir 2,454; SA Yadav 60·1,544·29.13·150.34; Vs Spin 38/454/140.99; leaderboard fielding JC Buttler 33/10/11/54. Number-adjacent → independent hand-written DuckDB (decision-39 shape).

## OPEN ITEMS the overall review should weigh (none are known bugs — verified-correct with caveats)
1. **Flag-ON runtime pass not yet done end-to-end.** Most filters verified flag-off; architecture guarantees flag-on works (db.js token-scans the full SQL incl. `inningsWhere`; all needed cols in the reconstruction vocab; binder-error → full-rebuild safety net) — but a full `?engine=ball` runtime pass of every filter belongs to the pre-cut integration. **Highest-value review follow-up.**
2. **Residual numbers-path gender guards (by design):** `matchupVsActive` (`gender!=="male"`), `profileSemiJoinSql`, `profileScopeTokens` in `src/state.js` still hardcode gender — number-critical belt-and-suspenders, left untouched. "Remove hardcode everywhere" for THESE is a separate numbers-sensitive task (likely with women's data). Offer path is fully data-driven.
3. **Perf (→ T-4 / cut):** per-row query aggregates all players/fielders then outer-wraps to one (no `id` push-down); the outer-wrap defeats the ball-engine single-player fast path (falls back to whole-scope reconstruction, mitigated by burst-folding); a flag-on leaderboard file-scoping quirk; fielding correlated-EXISTS. All correctness-safe.
4. **Matchup-row columns gap:** on a matchup Vs row, plain-only columns read "—" and matchup-only columns (coverage) aren't shown — a columns-rejig-era call.
5. **By design:** matchup Vs rows combine with scope, NOT per-innings numeric slices (Option A). Batting position is batting-only.
6. **Availability keyed per-GENDER, not full scope** (worker's Rule-3 flag) — reproduces today's behaviour exactly; per-format/date hiding would be a one-line change if wanted.
7. **Minor:** date inputs are month-type so a full YYYY-MM-DD scope date reads blank on open (retained + applied; pre-existing, shared with the batting editor); fielding `out_role` surfaces a literal "Unknown"; ~200ms optimistic-availability window after a gender switch (self-corrects; inert).
8. **UX as-built (owner said "go for it"):** the Filters tab owns its own Batting|Bowling|Fielding control; the pop-up header toggle is hidden while on the Filters tab. Review can reconsider.

## Do NOT touch
- **`SPEC.md` + `review/BACKLOG.md`** — drafts are HELD until the cut (owner Option B). Leave them.
- The sacred query builders (`buildQuery`/`buildMatchupQuery`/`buildScopeClauses`/`conditionToHaving`/`buildFieldingCteSql`) — numbers sacred.

## After the review
Per the owner-confirmed order: overall review → columns rejig → columns-in-popup + presets → AND/OR filters → harmonisation sweep → integrated review → **ball-layer cutover (LAST; push happens there)**.
