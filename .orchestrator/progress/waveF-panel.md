# Wave F1 — Unified Panel component (progress)

Branch: `ball-layer`. Owner: frontend-heavy (Opus).

## Approach (decided)
EXTEND `src/searchSelect.js` (the S component + documented migration target) into the
superset, rather than build a second component. searchSelect.js already had: rounded
popover (shared `.search-select__panel` base = `--shadow-popover` + `--radius-md`),
single (`mountSearchSelect`) + multi (`mountSearchMultiSelect`) variants, keyboard nav,
focus mgmt, group headers, dead-pick/pin, and a built-in portal (a superset of
filters.js `wirePortalDropdown` — it also flips above when there's no room below).

The ONE real gap vs the P (checkbox-panel) pattern: P has **no search box**. So the
single extension is an **optional search box** — `searchable: true | false | 'auto'`.
That lets ONE component express N (native single-select), P (checkbox multi, no search)
and S (searchable single/multi). Single vs multi stays two functions of the one module
(different state/handlers) — that IS the one component/design language, not two rivals.

Key risk: existing S callers (graph.js, playerFilters.js, drawerInnings.js) must stay
byte-identical. Mitigation: `searchable` defaults to `true` → every current call site is
unchanged; the readonly/hidden-filter path only engages when a caller opts out.

## Status — DONE
- [x] Read plan, audit, searchSelect.js, drawer.js/drawerInnings.js sites, CSS, wirePortalDropdown.
- [x] searchSelect.js: add `searchable` (+ autoSearchThreshold) to both functions.
- [x] styles.css: no-filter hidden-but-focusable filter; cond-row panel sizing.
- [x] drawer.js: migrate 5 profile pickers (hand, bowling, roleGroup/roleSub/roleBowling) N→panel.
- [x] drawerInnings.js: migrate R.Pos P→panel (mountSearchMultiSelect, searchable:false).
- [x] Verify: node --check ✓; boot 0 console errors ✓; anchors on screen ✓
      (2,813 / Karanbir 2,454 / SA Yadav 60·1,544·29.13·150.34); keyboard type-to-jump+Enter ✓;
      R.Pos "1, 2" value summary ✓; S Team picker unchanged ✓; 375px no overflow ✓.

## Portal bug found + fixed (important for the mass migration)
The no-filter CSS was first scoped to the HOST (`.search-select--no-filter .search-select__filter`).
But with `portal:true` the OPEN panel is reparented to `<body>`, so it's no longer a descendant of
the host → the rule stopped matching and the search box showed. FIX: `applySearchable()` now also
toggles `search-select__panel--no-filter` on the PANEL element (which always travels with its own
filter), and the CSS keys off that. Any panel-scoped CSS in later waves MUST key off the panel, not
the host, for the same reason.

## Gotchas found
- R.Pos toggle label is VALUE-based ("1, 2, 3" / "N selected"), not count-based.
  `summarize(count,total)` can't express that alone — but the established pattern
  (mountScopedMultiSelect) closes over the handle and calls `handle.getValues()` inside
  summarize. Reused that. FLAG for mass-migration: many P sites have value-based labels.
- R.Pos values are NUMBERS (1..11). normalizeOptions keeps non-string values as-is; Set
  membership + getValues round-trip numbers fine. Verified store writes stay numeric.
- Profile rows are `menOnly` → `isPresent` hides them on Women (not greyed). No disable
  handling needed inside the picker.
- Profile pickers sit in `.cond-row__value`; native selects were content-width. Panels
  are width:100% → need a cond-row sizing rule to keep the compact look.
</content>
</invoke>
