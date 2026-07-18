# Design Round 4 — owner review checklist (Waves A, B, C)

Go through this on **localhost:8000** (`python3 -m http.server 8000`). Waves A and C are built +
orchestrator-verified; **Wave B will be appended here once built.** Tick each item.

## 0. Setup + the sacred numbers (must be EXACT)
1. Open Filters. Confirm scope: **Men / Batting / T20 / International**. Set dates **01/07/2023 → 02/07/2026**. Search.
2. [ ] Total reads **2,813 players**.
3. [ ] Row 1 = **Karanbir Singh — 2,454 runs, 175.29 SR**.
4. [ ] Row 11 = **SA Yadav — 64 Mat / 60 Inns / 1,544 runs / 29.13 avg / 150.34 SR**.
5. [ ] Toolbar **Vs → Spin**, Search: **SA Yadav = 38 inns / 454 runs / 140.99 SR** (matchup mode).
6. [ ] Bowling + **Vs Right-handers** + position condition 1 & 2: **Bumrah = 27 inns / 177 balls / 9 wkts**.

## Wave A — filter & condition fixes (in BOTH Stats and Graphs → Filters)
7. [ ] Filters → "+ Add condition": the **first** entry is **"Matchup (Vs)"** (used to be "Vs", 10th). Same in the Graphs Filters.
8. [ ] Toolbar "Vs" control still reads just **"Vs"** (you chose to leave it).
9. [ ] Bowling discipline → "+ Add condition" → **Best Bowling** shows a **two-box** control: **"≥ [W] wickets for ≤ [R] runs"** (no operator dropdown).
10. [ ] Bowling, no Vs, add **Best Bowling ≥ 5 wickets for ≤ 20 runs** → **72 bowlers**; the BBI column shows figures like 7‑19, 6‑9, 5‑20 (5‑20 is on the boundary and correctly included).
11. [ ] Batting, **Vs Spin**, add **High Score** condition ≥ **47** → **83 players**, SA Yadav present; change to ≥ **48** → **73 players**, SA Yadav gone.
12. [ ] Bowling under **T20** only: Best Bowling label reads **"Best Bowling"** (no "(Innings)"). Add **Red Ball** format → it reads **"Best Bowling (Innings)"**.

## Wave C
### 4d
13. [ ] Filters footer has a **"Keep Selected Columns"** checkbox, **unchecked** by default, to the left of Search.
14. [ ] With it OFF: on default columns, switch Format (T20 → Red Ball) and Search → columns swap to that format's defaults. With it ON: your columns/order stay put across the switch.
15. [ ] Pin a player with **no innings in scope** (top search → type "Sciver" → pick NR Sciver‑Brunt) → pill reads **"+ NR Sciver‑Brunt (no innings)"** and a brief toast appears; the player count doesn't change.
16. [ ] Graphs tab → the player-list reset link reads **"Reset to full filtered set"**.
### 4e
17. [ ] Filters → open **Team / Against / Event / Venue** pickers with the **full** date range → long lists (Events ≈ 228, Venues ≈ 179).
18. [ ] Narrow the date to about **one month** and reopen those pickers → the lists **shrink** to only what occurred in that window (Events ≈ 15, Venues ≈ 13).
19. [ ] (Edge case — see chat: pick a team, then narrow the date past its window → the pill + numbers still honor the pick; only the picker checkbox looks empty. Decision pending.)
### 4f
20. [ ] Open a player popup (top search → pick a name) → **Player Filters** → the **Against / Vs / Date** controls are **searchable dropdowns** (click → a search box appears; type to filter). Picking one re-scopes the popup.
### Cleanup
21. [ ] Everything looks visually unchanged — no broken layout/styling anywhere (the removed CSS was unused leftovers).

## Wave B — matchup-aware Graph
*(To be appended once Wave B is built + verified.)*
