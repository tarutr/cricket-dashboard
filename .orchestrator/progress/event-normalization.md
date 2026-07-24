# Event + Stage name normalization (backlog #5, part 1)

Branch: polish-b1-mechanical (from HEAD 59d71e6) · Status: COMPLETE (verified on
localhost against the local Wave-6 export; config override reverted to R2).

## Approach + key risk
Display-collapse ONLY — no data rewrite. Pickers show canonical labels; state
stores canonical; the query builders expand a selected canonical back to its raw
alias set in the IN-list. KEY RISK was Rule 1: the event clause lives in
`buildScopeClauses` and the stage clause in `buildMatchContextClauses`, both used
by buildQuery / buildMatchupQuery / the graph fetch. Both are gated (event/stage
filter active), so with NOTHING selected the emitted SQL is unchanged — the
expansion only rewrites the IN-list WHEN a canonical is picked. Proven byte-identical.

## What changed
- NEW `src/canonicalNames.js` — embeds the owner-vetted map from
  `.orchestrator/event_canonical_map.json` VERBATIM (21 event canonicals ← 87 raw
  names; 5 stage canonicals ← 12 spellings; the two curly-apostrophe U+2019
  aliases preserved byte-exact so they still match raw DB values). Exports
  `canonicalEvent` / `eventAliases` / `canonicalStage` / `stageAliases` +
  `typographyNormalize` (U+2019→', collapse whitespace) applied as the fallback
  for unlisted names. Unlisted → identity (matches only itself). Fidelity checked:
  round-trips every alias 0 errors.
- `playerData.js` `searchEvents` — folds raw event_name → canonical option,
  de-duplicated, `games` summed / `latestDate` maxed across spellings; ORDER BY
  reproduced in JS after the fold. `searchEventSeasons` — expands the selected
  canonicals to their alias set, groups by (canonical, season) so a season shared
  across eras is one row; returns `event`=canonical (caller keys on it).
- `filters.js` — event clause (both the no-narrowing and per-event-season paths)
  and stage clause now expand canonical → raw alias IN-list (deduped). Import of
  canonicalNames added.
- `drawerInnings.js` — Stage picker loads raw stages, folds to canonical + dedups
  (A–Z). `KNOCKOUT_STAGES_CANON` = the 42 vetted raw values projected through
  `canonicalStage` (shrinks, no reclassification); knockout button matches canonical.
- `state.js` — comment-only: state.event / eventSeasons / stage now hold canonical.
- `pills.js` — NO change (already renders state.event/stage/eventSeasons values →
  now canonical; reads cleanly).

## Verified
- `node --check` on all touched files: pass.
- BYTE-IDENTICAL harness (HEAD 59d71e6 vs working tree, NO event/stage filter):
  buildQuery batting + bowling (incl. matches col), buildMatchupQuery bowling-vs-RHB,
  and the graph plain-branch fetch — diff empty, 4194 == 4194 bytes.
- Anchors reproduced in-app (Men/T20/International, 2023-07-01→2026-07-02):
  2,813 players / Karanbir Singh 2,454 / SA Yadav 60 inns·1,544 runs·29.13 avg·150.34 SR.
- Independent DuckDB cross-checks (hand-written SQL vs data/cricket.duckdb +
  data/export, NOT the app's aggregation):
  - (a) canonical "ICC Men's T20 World Cup" = union of its 3 aliases. Picker games
    in anchor scope = 93 == independent scoped union 93 (older spellings pre-2023,
    0 in window; all-time union = 173+104+57 = 334). Full leaderboard buildQuery
    with the canonical → 360 players / SA Yadav 388·16 == independent recompute.
  - (b) canonical stage "Semi-Final" → `event_stage IN ('Semi Final','Semi-Final',
    'Semi-final')`; men's union 206 == 192+11+3. Picker shows "Semi-Final" once, no
    strays; the two longer semi variants stay separate (identity — precise, not greedy).
  - (c) County Championship season picker (Domestic/Red Ball/2014→): one merged
    option (games 1429); `searchEventSeasons` returns 12 seasons 2014–2026 across
    all three sponsor eras (LV= 2014-15, Specsavers 2016-19, unsponsored 2021-26;
    2020 absent = COVID). Narrowed to 2015 → app clause `(event_name IN (3 aliases)
    AND season IN ('2015'))` counts 135 matches == independent recompute.
- Typography safety: EVERY unmapped event/stage has norm(raw)==raw (checked all
  1085 events / 53 stages), so identity `eventAliases(canonical)=[canonical]`
  matches the raw DB value exactly — the only 2 curly-apostrophe names in the data
  are both mapped aliases.
- Multi-alias season picker end-to-end: County Championship confirmed working (see (c)).
- 0 console errors throughout boot + all interactions.

## Concerns (flagged, not resolved)
- Pre-existing toolbar/popup asymmetry carries over unchanged: a TOOLBAR date change
  keeps the event selected and live-recomputes seasons (reconcileNarrowing prunes
  out-of-scope seasons); a POPUP date change clears the event (owner decision
  2026-07-18). A gender/format/team-type/date scope change clears state.event AND
  eventSeasons (filters.js), so in practice a multi-alias canonical's season list
  is re-derived by re-picking under the new window — unchanged by this task.
- `.orchestrator/event_canonical_map.json` is the source of truth; the map is
  embedded in canonicalNames.js (the app can't read .orchestrator at runtime). If
  the JSON changes, regenerate the two consts.
