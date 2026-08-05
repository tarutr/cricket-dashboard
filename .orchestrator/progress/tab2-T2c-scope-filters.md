# T-2c — scope singletons + opponent/window editors + 2 UX changes (progress)

Branch `ball-layer`, main working tree. NO git (orchestrator commits).
Numbers-sacred (CLAUDE.md Rule 1). Flag-OFF proofs vs R2; opponent/window need the
LOCAL ball snapshot (revert config.js after).

## Approach (stated for the record)
- **Query side (Part B) is FREE:** buildQuery already applies opposition/event/venue/
  inningsNumber/teams (buildScopeClausesTagged) + result/tossResult/tossDecision/stage/
  resultCondition (buildMatchContextClauses). So buildRowState overlays a per-row
  `singletons` partial-state onto the clean rowState → buildQuery slices automatically.
  buildQuery UNCHANGED. Empty singletons → empty clauses → no-filter row byte-identical
  BY CONSTRUCTION (the same guarantee the leaderboard has).
- **UI side (store-adapter shim):** new `src/playerFilterScope.js` presents a store-like
  object backed by a local `singletons` draft; get() = createInitialState overlaid with
  the editor's per-row scope + the draft picks; set() records + re-syncs. It mounts the
  drawer's REAL value editors (mountOpposition/Event/Venue/Stage/Result/TossResult/
  TossDecision/InningsNumber/Team + mountOpponentPlayer + mountWindow{Phase,Overs,Balls,
  Player}). ONE shared controller app-wide (mounted once → document listeners once, like
  the drawer); the editor modal borrows its persistent host via mountInto/detach.
- **deliveryWindow/opponentPlayer** are ball predicates → NOT on rowState; the row carries
  them and fetchRow threads them per-call to db.query (T-2b-i threading, untouched).
- **Row labels:** describeRowSingletons() adds honest tokens ("vs Australia", "Powerplay",
  "Innings: 1st innings", …) so a scope-only row never reads "No conditions".
- **paletteGroups.js:** POPUP_SCOPE_SINGLETON_KEYS un-withholds exactly the in-scope
  singletons on surface="popup" (leafSingle/singleFamily/matchResultFamily). Leaderboard
  BYTE-UNTOUCHED (all changes gate on surface==="popup"). Matchup Vs + fielding stay
  WITHHELD.

## Files changed
- src/paletteGroups.js — POPUP_SCOPE_SINGLETON_KEYS + popupWithholdsSingleton; leafSingle/
  singleFamily now offer the allowed keys on popup; matchResultFamily offered on popup.
- src/playerFilterScope.js (NEW) — controller + SINGLETON_DEFS + describeRowSingletons +
  getScopeSingletonsController (module singleton).
- src/playerFilterEditor.js — scopeController deps; scope-rows host; palette pickSingleton/
  isPresent/SINGLETON_TYPES/preselect* wired; commit gathers singletons/deliveryWindow/
  opponentPlayer; teardown detaches; onScopeChanged on format/teamtype/date; edit-commit
  button reads "Add Filter Row" (UX change 1).
- src/playerFiltersTab.js — row.singletons; buildRowState overlay; rowAllLabels (numeric +
  singleton labels); openEditor passes controller + edit pre-fill; discipline reset + warning
  in show() + reset-notice in shell/renderRows (UX change 2).
- styles.css — .pfe-scope-row(s) + .filters-tab__reset-notice.

## Status — COMPLETE + VERIFIED
- [x] node --check all touched files OK; config.js REVERTED (git-clean).
- [x] flag-off R2: leaderboard 2,813 / Karanbir 2,454 (on screen); flag-on-inactive same.
- [x] no-filter row == leaderboard byte-identical: batting 64·60·1,544·29.13·150.34·100·142·80;
      bowling 64·1·2·2.50·5.00·3.00·2-5.
- [x] scope slice via UI == INDEPENDENT DuckDB (raw COUNT/SUM, not app shape):
      Opposition=Australia → 10·259·28.78·167.10 EXACT; Innings=1st → 38·948·26.33·147.66 EXACT.
      Row labels read honestly ("vs Australia", "Innings: 1st innings") — no "No conditions".
- [x] opponent-player (flag-on local snapshot): vs NT Ellis → 8·72·72.00·194.59 EXACT vs raw head-to-head.
- [x] window (flag-on): Phase=Powerplay → 41·465·29.06·137.98 EXACT (avg 29.06 = 465/16 dismissals,
      16 = 15 striker + 1 non-striker run-out; my first hand-query wrongly filtered batter_id=SKY and
      missed the non-striker out — the APP is correct).
- [x] discipline switch (Batting→Bowling) RESETS rows + shows warning "Switching to Bowling cleared
      your filter rows — a batting filter can't slice bowling."; notice clears on next Add.
- [x] edit-mode: title "Edit Filter Row", commit button "Add Filter Row"; edit pre-fills the scope singletons.
- [x] palette (popup surface): offers Team/Opposition/Event/Venue/Stage/Match&Toss Result/Innings Number +
      PotM(Y/N) + numeric slices; flag-on adds Ball Ranges (Phase/Over Range/Team Ball Range/Batter-Bowler
      Ball Range) + Matchup(Vs)={vs opponent player ONLY}. Matchup vs bowling/hand/pos + fielding WITHHELD.
- [x] 0 console errors flag-off AND flag-on across all interactions.

## Observation (not a T-2c defect — flag for orchestrator)
- The "matches" (MAT) column for an OPPONENT / WINDOW row shows the WHOLE-SCOPE match count (e.g. vs
  NT Ellis MAT=64, not 8). Cause: opponent/window are ball predicates threaded via db.query; they do NOT
  flip buildQuery's `inningsLevel`, so MAT comes from player_matches (whole scope). This is the EXISTING
  T-1/T-2b-i threading behavior (same on the leaderboard), NOT introduced by T-2c — my code sets the ball
  predicate on the row; I do not touch buildQuery/inningsLevel. Every other column (inns/runs/avg/SR/…) is
  computed over the correct filtered balls and is exact.

## NOT in this wave (left WITHHELD — confirmed)
- Matchup "Vs" filters (vs bowling style / vs batting hand / batting position) route through
  buildMatchupQuery (a different path the tab doesn't use) — orchestrator handles next.
