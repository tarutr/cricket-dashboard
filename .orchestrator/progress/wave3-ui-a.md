# Wave 3 (UI, part A) — the "Delivery window" filter control on the Stats leaderboard

Branch `ball-layer`. Owner: decision 67 ("Wave-3 window CONTROL design SIGNED OFF"). The
engine (src/deliveryWindow.js + db.js setDeliveryWindow) was DONE + verified in the engine
half (wave3-engine-window.md); this wave builds the visible drawer control + wiring and
leaves Graphs + player-popup window surfaces to part B.

## What shipped (files, one line each)
- **src/drawerInnings.js** — NEW `mountDeliveryWindow(container, store, onChange)`: the ONE
  combined editor (Team innings mode toggle Phase|Overs|Balls + phase chips / from–to ranges;
  This player First|Last N + unit). Keeps a LOCAL DRAFT as UI source-of-truth, derives an
  always-valid-or-null spec into state.deliveryWindow, and a `lastWritten` guard stops sync()
  from stomping a focused input.
- **src/drawer.js** — new SINGLETON_TYPE `{key:"window", label:"Delivery window", ballOnly}`,
  mounted controller, added to syncSingletonRows / hasValue / isPresent / clearSingleton /
  activeCount; a "Delivery" optgroup in the "+ Add condition…" dropdown. ALL gated on
  `ballEngineEnabled()` (imported from config.js) + isEmptyDeliveryWindow (from deliveryWindow.js).
- **src/state.js** — describeScope() gains the window token via `describeDeliveryWindow`
  (ONE label source); NEW `pruneDeliveryWindowForFormats(store)` drops a Phase/Balls team clause
  the format no longer permits (red ball / mixed → Overs only).
- **src/pills.js** — a removable "Delivery window" pill from the APPLIED snapshot via
  `describeDeliveryWindow`; ×/+ soft-deletes on the live store, commits on Search.
- **src/main.js** — imports `setDeliveryWindow`; runSearch() calls `setDeliveryWindow(appliedState.deliveryWindow)`
  right after committing the applied snapshot (the Search-gate); onFiltersChanged() calls
  `pruneDeliveryWindowForFormats`; clearAll() resets the engine window to null.
- **styles.css** — `.dwin*` block (two stacked sub-sections; sub-labels go full-width < 640px so
  it stacks cleanly at 375px). No index.html change (skeleton row built by drawer.js).

## Interaction model
- Gated to the ball engine: renders ONLY when `ballEngineEnabled()`. Flag-OFF the option +
  optgroup are absent and the skeleton row stays hidden — byte-untouched.
- Search-gated + staged like every singleton: editing writes state.deliveryWindow (pending);
  the frozen table never moves; the POPUP's own Search (always active) or the toolbar Search
  commits pending→applied, then `setDeliveryWindow` runs BEFORE the query.
- Pins OBEY it (window is in the base CTE, not a who-to-list filter) — falls out automatically.
- Format gating (enforced in UI): single T20 / single 50-over show Phase|Overs|Balls; red ball +
  mixed show Overs ONLY (buttons hidden, mode falls to Overs; a stale Phase/Balls clause is pruned
  by pruneDeliveryWindowForFormats). Overs capped 20 (T20) / 50 (50-over) / uncapped (red/mixed);
  Balls capped 120 / 300. Player clock in ALL formats; unit follows discipline (faced/bowled).

## VERIFICATION (localhost:8000, flag-ON via ./explorer→data/wave1_out + temp DATA_BASE_URL
override, both reverted/removed after; 1280×800; also 375×812 mobile)
- **Control renders + gating**: single-T20 shows Phase/Overs/Balls + chips + This-player; single
  Red Ball + MIXED (Red Ball+T20) show Overs ONLY (Phase/Balls hidden), player section persists.
- **Windowed leaderboard (on screen + independent hand DuckDB check over the raw delivery parquet
  — decision 39, different shape from the engine's crease-union):**
  | window (SA Yadav) | inns | runs | balls | SR | pill |
  |---|---|---|---|---|---|
  | Death (phase) | 13 | 185 | 96 | 192.71 | "Death overs" |
  | First 10 faced | 60 | 634 | 476 | 133.19 | "first 10 faced" |
  | First 10 ∧ Death | 11 | 25 | 14 | 178.57 | "Death overs, first 10 faced" |
  Independent checks returned 185/96/192.71, 634/476/133.19 (organic row), 25/14/178.57 — 0 mismatch.
  (First-10∧Death inns=11 is the deferred case-f "crease-present" rule, which STANDS per decision 67.)
- **Pins obey**: SA Yadav pinned under Death shows 13/185/96/192.71 (windowed), not full-scope
  60/1,544/150.34. Karanbir Singh (full-scope 2,454) pinned under Death∧First-1 shows INNS 1 /
  RUNS 0 / BF 0 / AVG — / SR — (independent: 0 in-window balls) — NOT his full-scope numbers.
- **Honest empties**: window = Overs 1–6 + a "Death Overs SR" column → the DEATH SR column reads
  "—" for every row (engine returns NULL; no special UI). Sanity-checked.
- **No-window byte-identical (flag-ON)**: 2,813 players / Karanbir 2,454 / SA Yadav 60·1,544·29.13·150.34.
- **Flag-OFF byte-untouched**: no "Delivery window" option, no "Delivery" optgroup, skeleton row
  hidden; anchors 2,813 / 2,454 / SKY hold; 0 console errors.
- **Mobile 375px**: control stacks (sub-labels full-width, chips wrap); documentElement scrollWidth
  == clientWidth == 375 (no horizontal page scroll).
- **0 console errors** flag-ON (1280 + 375) and flag-OFF. `node --check` clean on all touched files.

## OPEN / for part B (Graphs + popup)
- **serializeQueryState (table.js — MUST-NOT-TOUCH) has no `deliveryWindow` key**, so a
  window-ONLY pending change does not light the TOOLBAR Search button's dirty cue (it stays
  "blocked", a no-op). The feature is fully functional because the POPUP's own Search button is
  always active and commits the window; the gap is only the "edit window → close popup WITHOUT
  searching → toolbar Search" path. A one-line, numbers-inert fix (add
  `deliveryWindow: state.deliveryWindow` to serializeQueryState) restores full parity with every
  other filter — NOT made here because table.js is off-limits. Recommend the orchestrator apply it
  or authorize it.
- The active window is a single global in db.js; a leaderboard Search sets it, so switching to the
  Graphs tab (flag-ON) would inherit the last-applied window (numbers windowed, footer via
  describeScope also windowed — self-consistent). Part B wires the graph/popup their own window
  controls + labeling per decision 67 ("works on the leaderboard AND in the popup").
