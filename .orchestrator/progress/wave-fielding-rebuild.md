# Fielding rebuild (Wave-3 redo at event grain) + Wave-4 spell-wicket fix

Branch: `polish-b1-mechanical`. Scratchpad DB (read-only): `scratchpad/cricket_w2.duckdb`
(copy of data/cricket.duckdb + profiles). Never touched `data/cricket.duckdb`. Build → `/tmp/export_fld`.
No push/merge. Never `--upload`.

## PART A — fielding at EVENT grain

### export_parquet.py — DONE + VERIFIED
- NEW `sql_fielding_events()` → **fielding_events.parquet**: ONE row per (wicket, credited fielder).
  Re-derived STANDALONE from raw wicket_fielders ⋈ wickets ⋈ deliveries (+ matches, player_profiles,
  and sql_batting's EXACT batting-position logic). Super-overs excluded.
  Credit: caught → each listed fielder; c&b → delivery BOWLER (fielder_index=0, no wf row);
  run out → ALL listed fielders; stumped → keeper. Substitute rows CARRIED (substitute flag);
  NULL-fielder_id rows dropped (unattributable — matches Wave-3 rule, keeps reconciliation exact).
  30 columns (see schema below). phase = single resolved-per-format value
  (Hundred/T20/IT20 → t20_phase_expr; ODI/ODM → ODI_PHASE_OVER; Test/MDM → NULL).
- Registered in EXPORT_FILES (PK = 6-col ball+fielder key), CONTENT_TYPES, main() write list.
  Gates/manifest/upload all iterate EXPORT_FILES → automatic.
- `sql_player_matches()`: DROPPED catches/stumpings/run_outs; **KEPT player_of_match** (per-match).
- run_gates: fielding oracle now reads catches/stumpings/run_outs from fielding_events
  (excl subs, by kind) + player_of_match from player_matches; +3 fielding_events structure gates.

### Verified (scratchpad cricket_w2 → /tmp/export_fld), all independent recomputes:
- Grand totals (excl subs): catches **201,520** / stumpings **9,397** / run_outs **26,252** — EXACT (Wave-3 match).
- MS Dhoni (4a8a2e3b): **766 / 235 / 169** — EXACT.
- NEW SLICE 1 — Dhoni catches vs Australia: **110** (raw-independent 110). EXACT.
- NEW SLICE 2 — Dhoni catches of position 1–3 batter: **333** (raw-independent 333). EXACT.
- c&b: fielder_id==bowler_id (0 mismatch), fielder_index=0. subs carried (3,266 rows).
- fielding_events.parquet: **240,435 rows / 4,374,828 bytes**. player_matches 2,536,589 → 2,383,190 (−3 cols).
- All structural/cross-check gates + 7 spot checks PASS.

Schema: match_id, innings_number, over_number, ball_index, wicket_index, fielder_index,
fielder_id, fielder_name, match_type, gender, team_type, match_date, year, month, venue, city,
event_name, fielding_team, opposition, kind, out_batter_id, out_batter_name, out_batting_position,
out_hand, out_role, bowler_id, bowler_name, bowler_style, phase, substitute.

## PART B — Wave-4 spell-wicket consistency fix — DONE + VERIFIED
- `sql_bowling()` `spell_wkts`: removed the legal-only filter (`sd.wides IS NULL AND sd.noballs IS NULL`).
  Spell wickets now count credited kinds on ALL spell deliveries, matching cricdb's `wkt_by_ball`/`wickets`.
- Gate: spell_count=1 ⇒ open_spell_wkts == wickets → **0 mismatches**.
- Source divergence (correct, source is buggy legal-only): **539** extra wickets across **536** spells.

## App wiring — DONE + VERIFIED (browser, localhost:8000, config-override → /tmp/export_fld)
- `config.js` PARQUET_FILES + `db.js` VIEWS: register fielding_events as view `fielding`.
- `metrics.js`: catches/stumpings/run_outs/dismissals_effected → source `fielding_events`
  (MAX(fielding_cte.…)); player_of_match → source `player_matches` (MAX(pom_cte.…)). Both
  disciplines. Header + block comments updated.
- `table.js` buildQuery: `fielding_cte` now sourced from event-grain `fielding` view, honoring
  the FULL scope incl. **opposition** (oppositionColumn:"opposition") + team (fielding_team) +
  event/venue + profile, substitutes excluded, + the fielding SLICE conditions
  (buildFieldingSliceClauses). NEW parallel `pom_cte` from player_matches for player_of_match
  (no opposition column — whole-match award). advancedReferencesFielding → advancedReferencesMetric
  + isFieldingEventMetric/isPomMetric. When no fielding column/condition: byte-identical to before.
- Fielding SLICE conditions (Dismissed position / Dismissal kind / Fielding phase) added as three
  singleton condition types in the "Fielding" dropdown group (drawer.js) + `state.fielding`
  {positions,kinds,phases} (state.js) + pickers (drawerInnings.js mountFieldingPosition/Kind/Phase)
  + pills (pills.js) + activeCount. PLAIN mode only (fielding has no matchup grain).

### Browser verification (zero console errors throughout, config reverted after):
- Anchors byte-identical: 2,813 displayed (2,810 distinct-id) / Karanbir 2,454 /
  SA Yadav 64·60·1,544·29.13·150.34. Bowling baseline 2,049.
- Fielding columns (batting): SA Yadav Ct=24, St=0, RO=4, PoM=5 (Ct matches independent 24).
- Fielding columns (bowling): Waseem Muhammad Ct=51 (independent 51), keyed by bowler_id.
- Fielding SLICE (via app buildQuery + UI): phase=death → SA Yadav Ct 24→6 (independent 6);
  position 1–3 → 10 (independent 10); opposition=South Africa → 6 (independent 6; SQL uses
  `opposition IN` in fielding_cte); kind='run out' → Ct 0 / RO 4. PoM UNAFFECTED by slices/opp
  (separate pom_cte) — correct.

## Status: COMPLETE — all five verification checks green.
