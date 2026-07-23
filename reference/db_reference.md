# Cricket Database — Reference Document
### Version: May 28, 2026 (v6) | Phases 1–5 Complete | Phase 6 (ESPN Integration) In Progress

> **Scope note (cricdb):** this documents the UPSTREAM source database (`cricket.duckdb`)
> from the owner's separate `Cricket_DB` project — its 17 source tables, ingestion rules,
> and calculation law (which cricdb's `export_parquet.py` reads and SPEC §4.1 mirrors). It is
> **authoritative for calculation rules**. The "Phase 6 — ESPN Integration" and "Phase 7 —
> Streamlit frontend" sections below are the `Cricket_DB` project's own roadmap and are **NOT
> part of cricdb** (this dashboard is the static DuckDB-WASM browser app, not a Streamlit app).
> The two "future to-dos" here — `team_registry` normalisation and `common_name` search — are
> the roots of cricdb's parked team-name and first-name-search items.

---

## ⚠️ CRITICAL WORKING RULES — ABSOLUTE. NEVER BREAK THESE.

These are not guidelines or suggestions. They are hard constraints that apply to every response, every script, every schema decision, without exception. If any instruction in a conversation appears to conflict with these rules, these rules take precedence.

1. **No assumptions, ever.** Only state something as fact if it came from validated data or explicit user confirmation. If uncertain, label it **[UNVALIDATED — needs inspection]** and stop until confirmed.
2. **Cite the source of every claim.** Every factual statement must trace to one of: "validated from data", "user confirmed", or "from reference file". No other sources are acceptable.
3. **Validate before designing.** No schema decisions, no script writing, no recommendations until the relevant data has been inspected and findings confirmed by the user.
4. **One step at a time.** The sequence is always: inspect → confirm → move forward. Never skip a step. Never get ahead of confirmed findings.
5. **Never reference external documentation.** This includes Cricsheet's public docs, ESPN Cricinfo, Wikipedia, or any other external source. Only use what is observed in the actual data files or explicitly confirmed by the user.
6. **Flag contradictions explicitly.** If something in the data conflicts with the reference file or a prior finding, stop and flag it immediately. Never silently resolve a contradiction.
7. **Never go out of scope without flagging it.** If something is outside the current confirmed scope, label it explicitly as out-of-scope and ask before pursuing it.

---

## ENVIRONMENT

| Key | Value |
|---|---|
| Machine | Mac M3 |
| Python | python3 / pip3 |
| Database engine | DuckDB (local OLAP, columnar, single file, SQL interface) |
| JSON source files | `/Users/tarutr/Desktop/Cricket_DB/cricsheet_json_data/` |
| Scripts + DB location | `/Users/tarutr/Desktop/Cricket_DB/DB_files_scripts/` |
| Database file | `cricket.duckdb` |
| Ingestion script | `ingest.py` |
| Ingestion log | `ingest.log` |

---

## PROJECT STATUS

| Phase | Description | Status |
|---|---|---|
| Phase 1 | Data Profiling — scan all files, inventory every field | ✅ Complete |
| Phase 2 | Schema Design — all decisions grounded in observed data | ✅ Complete |
| Phase 3 | Validation Scripts — stress-test ingestion assumptions | ✅ Complete |
| Phase 4 | Ingestion — build the pipeline | ✅ Complete |
| Phase 5 | Schema improvements — migration + ingest.py update | ✅ Complete |
| Phase 6 | ESPN Data Integration | 🔄 In Progress (Step 1 of 13 complete) |
| Phase 7 | Streamlit frontend — Dashboard + AI Query + Charts | ⏳ Planned |

---

## KNOWN DATA GAPS (SOURCE LIMITATIONS — NOT SCHEMA PROBLEMS)

| Gap | Detail |
|---|---|
| Afghanistan matches | Afghanistan cricket matches are not covered by Cricsheet. Any query involving Afghanistan will return zero results. Source data limitation, not a schema problem. |
| Pre-2017 event_name coverage | 89 matches between 2005–2017 have no `event_name`. All are one-off games and associate nation fixtures. Nothing missing after 2017. Series identification using `event_name` + `season` is reliable for post-2017 matches only. |

---

## VALIDATED DATASET FACTS

All figures validated from observed data unless otherwise noted.

### Top-level (as of May 28, 2026)
- Total files ingested: **21,849**
- Total innings: **48,483**
- Total wickets: **338,532**
- Parse errors: 0
- wi_ prefix files: 25
- Top-level JSON keys: `meta`, `info`, `innings` (all 3 always present in every file)

### match_type distribution (original 21,376 files)
| Value | Count |
|---|---|
| T20 | 13,104 |
| ODI | 3,100 |
| MDM | 2,100 |
| ODM | 1,852 |
| Test | 900 |
| IT20 | 320 |

### Outcome shapes (all 8 confirmed exhaustive)
| Shape | Count |
|---|---|
| {winner, by} | 18,776 |
| {result} | 1,530 |
| {winner, by, method} | 942 |
| {result, eliminator} | 102 |
| {result, method} | 18 |
| {winner, method} | 5 |
| {result, bowl_out} | 2 |
| {result, method, eliminator} | 1 |

### Season label validation (validated April 2026)
Every `season` value fits exactly one of two formats. Zero exceptions validated.

| Format | Example | Meaning |
|---|---|---|
| `"YYYY"` | `"2024"` | Single-year season — all matches confirmed within that calendar year only |
| `"YYYY/YY"` | `"2024/25"` | Cross-calendar season — all matches confirmed spanning both calendar years |

### event_name coverage (validated April 2026)
| match_type | Coverage |
|---|---|
| IT20 | 100% |
| MDM | 100% |
| ODM | 100% |
| Test | 99%+ |
| ODI | 99%+ |
| T20 | 99.5% |

### Wide and no-ball storage (validated April 2026)
- `wides` stores total wide runs on the delivery including boundary wides — range 1–5 observed
- `noballs` stores total no-ball extras on the delivery — range 1–6 observed. Some tournaments use 2-run no-ball penalty. Stored exactly as source data.
- `runs_conceded` for bowlers = SUM(runs_batter + noballs + wides) — byes and leg byes excluded

### Known data quality issues
| Issue | Handling |
|---|---|
| 1 wicket record has typo: `playeer_out` | Use `w.get("player_out") or w.get("playeer_out")` on ingestion |
| 1 delivery has 10 wickets | Data error — flagged via `data_quality_flag` column |
| 10 deliveries have 2 wickets | Rare but valid — stored correctly |
| 13 files have duplicate `over` field inside deliveries | Silently ignored on ingestion |
| `season` field is integer in 1,685 files | Cast to string on ingestion |
| `event.group` field is integer in 1,316 files | Cast to string on ingestion |
| 9 files have duplicate `player_of_match` entries | `ON CONFLICT DO NOTHING` on ingestion |
| 44 bowling_spells rows and 6 innings_bowlers rows have overs_bowled = 0.0 despite balls > 0 | Source data issue — Cricsheet has overs with 7 legal deliveries, confirmed against ESPNcricinfo. Not fixed — we do not correct raw source data. economy and per_ball_economy are NULL for these rows. |

---

## INGESTION RULES

| Rule | Detail |
|---|---|
| match_id | Full filename stem — e.g. `1234567.json` → `1234567`, `wi_211979.json` → `wi_211979` |
| player_id | From `registry.people[player_name]` in each file |
| official_id | Synthetic — generated by ingestion pipeline on first encounter |
| season | Cast to string if integer |
| event.group | Cast to string if integer |
| season_year_start | Parsed from first year of season string — `"2024"` → 2024, `"2024/25"` → 2024 |
| season_year_end | Parsed from last year of season string — `"2024"` → 2024, `"2024/25"` → 2025 |
| is_not_boundary | Mapped from `runs.non_boundary` in JSON — TRUE or NULL only |
| playeer_out typo | `w.get("player_out") or w.get("playeer_out")` |
| Delivery-level over field | Silently ignore — duplicate of parent, affects 13 files only |
| data_quality_flag | Populated when wicket_count > 2 |
| player_registry | Built via upsert during ingestion |
| officials_registry | Built via upsert during ingestion |
| match_dates_overflow | Only populated when a match has more than 6 dates (currently 0 rows) |
| player_of_match duplicates | ON CONFLICT DO NOTHING |
| Transactions | Each file wrapped in single transaction — full commit or full rollback |
| Incremental re-runs | ingested_files checked at start — already-processed files skipped |
| runs_conceded (bowler) | SUM(runs_batter + noballs + wides) — byes and leg byes excluded |
| Legal delivery (bowler) | wides IS NULL AND noballs IS NULL — both must be absent. Used for balls, overs_bowled, dots, fours, sixes, wickets in innings_bowlers and bowling_spells. |
| Legal delivery (batter) | wides IS NULL only — batters face no-balls, so no-balls count towards balls_faced. |
| Maiden calculation | Complete over (6 legal deliveries, same over_number) where SUM(runs_batter + wides + noballs) = 0 |
| Spell break definition | Gap of 3+ over numbers = new spell. Gap of 1 or 2 = same spell continues. Validated: overs 10,12,14,16,18 = one spell. Overs 18→30 = new spell. |
| Super over exclusion | innings_batters, innings_bowlers, bowling_spells exclude super over innings entirely |
| overs_bowled format | Cricket convention — 3.4 means 3 complete overs and 4 completed legal balls. Display with ROUND(overs_bowled, 1). |

---

## VALIDATED DEFINITIONS (Phase 5)

| Definition | Detail |
|---|---|
| Entry point | ball_index of first delivery where batter appears in `batter` OR `non_striker` column |
| Exit point | ball_index of last delivery where batter appears in `batter` OR `non_striker` column |
| Batting partners | Count of distinct players appearing as `batter` OR `non_striker` alongside primary batter between entry and exit points, excluding primary batter |
| Batting position | Order of first appearance in `batter` column only |
| overs_bowled | Cricket convention — validated: AW Gorvin 20.0 overs confirmed against Cricinfo scorecard |
| Spell break | Gap of 3+ over numbers = new spell. Validated against match 1410291. |

---

## ID REFERENCE

| ID | Type | Source |
|---|---|---|
| match_id | Source ID | Filename stem |
| player_id | Source ID | registry.people in each JSON file |
| official_id | Synthetic ID | Generated by ingestion pipeline on first encounter |
| batter_id | Source ID | registry.people lookup |
| bowler_id | Source ID | registry.people lookup |
| non_striker_id | Source ID | registry.people lookup |
| player_out_id | Source ID | registry.people lookup |
| fielder_id | Source ID | registry.people lookup |

---

## SCHEMA — ALL 17 TABLES

### Table: matches
*One row per match. PK: match_id*

| Column | Type | Notes |
|---|---|---|
| match_id | VARCHAR PK | Filename stem — source ID |
| match_type | VARCHAR | T20, ODI, MDM, ODM, Test, IT20 |
| gender | VARCHAR | "male" or "female" |
| season | VARCHAR | Always string |
| season_year_start | INTEGER | First year of season. "2024" → 2024. "2024/25" → 2024 |
| season_year_end | INTEGER | Last year of season. "2024" → 2024. "2024/25" → 2025 |
| city | VARCHAR | Optional |
| venue | VARCHAR | Always present |
| match_date_1 | DATE | Always present |
| match_date_2–6 | DATE | Optional |
| balls_per_over | INTEGER | Always present |
| overs | INTEGER | Optional |
| team_type | VARCHAR | "international" or "club" |
| team_1 | VARCHAR | |
| team_2 | VARCHAR | |
| toss_winner | VARCHAR | |
| toss_decision | VARCHAR | "bat" or "field" |
| toss_uncontested | BOOLEAN | Optional |
| event_name | VARCHAR | Optional |
| event_match_number | INTEGER | Optional |
| event_group | VARCHAR | Optional |
| event_stage | VARCHAR | Optional |
| event_sub_name | VARCHAR | Optional |
| winner | VARCHAR | Optional |
| result_type | VARCHAR | Optional — "draw", "no result", "tie" |
| result_margin | INTEGER | Optional |
| result_margin_type | VARCHAR | Optional — "runs", "wickets", "innings" |
| method | VARCHAR | Optional — "D/L", "VJD", "Awarded", "Lost fewer wickets" |
| supersubs | JSON | Optional |
| bowl_out | JSON | Optional — rare (2 matches) |
| missing_fields | JSON | Optional |
| meta | JSON | Always present |

---

### Table: match_dates_overflow
*Only populated when a match has more than 6 dates. Currently 0 rows.*
PK: `(match_id, day_number)`

| Column | Type | Notes |
|---|---|---|
| match_id | VARCHAR | FK → matches |
| day_number | INTEGER | 1-based |
| match_date | DATE | |

---

### Table: innings
*One row per innings per match.*
PK: `(match_id, innings_number)`

| Column | Type | Notes |
|---|---|---|
| match_id | VARCHAR | FK → matches |
| innings_number | INTEGER | 0-based |
| batting_team | VARCHAR | |
| declared | BOOLEAN | Optional |
| forfeited | BOOLEAN | Optional |
| super_over | BOOLEAN | Optional — TRUE for super over innings |
| target_runs | INTEGER | Optional |
| target_overs | FLOAT | Optional |
| penalty_runs_pre | INTEGER | Optional |
| penalty_runs_post | INTEGER | Optional |
| miscounted_overs | JSON | Optional |
| absent_hurt | JSON | Optional |

---

### Table: powerplays
*One row per powerplay per innings.*
PK: `(match_id, innings_number, powerplay_index)`

| Column | Type | Notes |
|---|---|---|
| match_id | VARCHAR | |
| innings_number | INTEGER | |
| powerplay_index | INTEGER | 0-based |
| from_over | FLOAT | |
| to_over | FLOAT | |
| type | VARCHAR | "mandatory", "batting", "fielding" |

---

### Table: deliveries
*One row per ball. Core ball-by-ball table.*
PK: `(match_id, innings_number, over_number, ball_index)`

**⚠️ over_number is 0-based.** Over 1 = `over_number 0`. Always subtract 1 when filtering.

| Column | Type | Notes |
|---|---|---|
| match_id | VARCHAR | |
| innings_number | INTEGER | |
| over_number | INTEGER | **0-based** |
| ball_index | INTEGER | 0-based position within over |
| batter | VARCHAR | |
| batter_id | VARCHAR | |
| bowler | VARCHAR | |
| bowler_id | VARCHAR | |
| non_striker | VARCHAR | |
| non_striker_id | VARCHAR | |
| runs_batter | INTEGER | |
| runs_extras | INTEGER | Delivery-level only — not used for bowler stats |
| runs_total | INTEGER | |
| is_not_boundary | BOOLEAN | TRUE = 4 or 6 scored by running. NULL = boundary hit or no boundary. Only TRUE or NULL — no FALSE values. |
| wides | INTEGER | Optional — total wide runs including boundary wides |
| noballs | INTEGER | Optional — total no-ball extras |
| byes | INTEGER | Optional — not charged to bowler |
| legbyes | INTEGER | Optional — not charged to bowler |
| penalty | INTEGER | Optional |
| wicket_count | TINYINT | 0 = no wicket |
| wicket_kind | VARCHAR | Convenience — first wicket only |
| player_out | VARCHAR | Convenience — first wicket only |
| player_out_id | VARCHAR | Convenience — first wicket only |
| data_quality_flag | VARCHAR | Optional — set when wicket_count > 2 |
| review_by | VARCHAR | Optional |
| review_umpire | VARCHAR | Optional |
| review_batter | VARCHAR | Optional |
| review_decision | VARCHAR | Optional |
| review_type | VARCHAR | Optional |
| review_umpires_call | BOOLEAN | Optional |
| replacements | JSON | Optional |

---

### Table: wickets
*One row per wicket. Authoritative record.*
PK: `(match_id, innings_number, over_number, ball_index, wicket_index)`

| Column | Type | Notes |
|---|---|---|
| match_id | VARCHAR | |
| innings_number | INTEGER | |
| over_number | INTEGER | |
| ball_index | INTEGER | |
| wicket_index | INTEGER | 0-based |
| player_out | VARCHAR | |
| player_out_id | VARCHAR | |
| kind | VARCHAR | caught, bowled, lbw, run out, caught and bowled, stumped, retired hurt, hit wicket, retired out, retired not out, obstructing the field, handled the ball, hit the ball twice, timed out |

---

### Table: wicket_fielders
*One row per fielder per wicket.*
PK: `(match_id, innings_number, over_number, ball_index, wicket_index, fielder_index)`

| Column | Type | Notes |
|---|---|---|
| match_id | VARCHAR | |
| innings_number | INTEGER | |
| over_number | INTEGER | |
| ball_index | INTEGER | |
| wicket_index | INTEGER | |
| fielder_index | INTEGER | 0-based |
| fielder_name | VARCHAR | |
| fielder_id | VARCHAR | |
| substitute | BOOLEAN | Optional |

---

### Table: match_players
PK: `(match_id, team, player_id)`

| Column | Type | Notes |
|---|---|---|
| match_id | VARCHAR | FK → matches |
| team | VARCHAR | |
| player_name | VARCHAR | |
| player_id | VARCHAR | |

---

### Table: match_player_of_match
PK: `(match_id, player_id)`

| Column | Type | Notes |
|---|---|---|
| match_id | VARCHAR | FK → matches |
| player_name | VARCHAR | |
| player_id | VARCHAR | |

---

### Table: player_registry
PK: `player_id`

| Column | Type | Notes |
|---|---|---|
| player_id | VARCHAR PK | Source ID from Cricsheet — NOT synthetic |
| player_name | VARCHAR | Format: initials + surname e.g. "RG Sharma". Search by surname. |

---

### Table: officials
| Column | Type | Notes |
|---|---|---|
| match_id | VARCHAR | FK → matches |
| official_name | VARCHAR | |
| official_id | VARCHAR | Synthetic ID |
| role | VARCHAR | "umpires", "tv_umpires", "reserve_umpires", "match_referees" |

---

### Table: officials_registry
PK: `official_id`

| Column | Type | Notes |
|---|---|---|
| official_id | VARCHAR PK | Synthetic |
| official_name | VARCHAR | |

---

### Table: ingested_files
PK: `file_name`

| Column | Type | Notes |
|---|---|---|
| file_name | VARCHAR PK | Full filename e.g. "1234567.json" |
| match_id | VARCHAR | Derived stem |

---

### Table: innings_batters
*One row per batter per innings. Super over innings excluded.*
PK: `(match_id, innings_number, batting_position)`

**TABLE RULE: Lookup and count only. Never aggregate calculations across rows. For any cross-innings calculation always use `deliveries`. Valid cross-innings uses: counting rows, filtering rows, comparing single-innings values.**

**Identity**
| Column | Type | Notes |
|---|---|---|
| match_id | VARCHAR | |
| innings_number | INTEGER | 0-based |
| batting_position | INTEGER | 1-based — order of first appearance in batter column |
| batter | VARCHAR | |
| batter_id | VARCHAR | |

**Innings context**
| Column | Type | Notes |
|---|---|---|
| entry_point | INTEGER | ball_index of first delivery where batter appears in batter OR non_striker |
| exit_point | INTEGER | ball_index of last delivery where batter appears in batter OR non_striker |
| out | VARCHAR | "dismissed", "not out", "retired hurt", "retired not out" |
| dismissal_kind | VARCHAR | NULL if not dismissed |
| batting_partners | INTEGER | Count of distinct players sharing crease during batter's innings |

**Raw counting stats**
| Column | Type | Notes |
|---|---|---|
| runs | INTEGER | |
| balls_faced | INTEGER | Excluding wides |
| dots | INTEGER | |
| ones | INTEGER | |
| twos | INTEGER | |
| threes | INTEGER | |
| fours | INTEGER | Boundary 4s only |
| non_boundary_fours | INTEGER | 4 runs scored by running |
| fives | INTEGER | |
| sixes | INTEGER | Boundary 6s only |
| non_boundary_sixes | INTEGER | 6 runs scored by running |
| non_boundary_runs | INTEGER | Total runs not from boundaries |

**Derived single-innings metrics**
| Column | Type | Notes |
|---|---|---|
| sr | FLOAT | runs / balls_faced * 100 |
| dot_pct | FLOAT | dots / balls_faced * 100 |
| boundary_run_pct | FLOAT | boundary runs / runs * 100 |
| non_boundary_run_pct | FLOAT | non_boundary_runs / runs * 100 |
| non_boundary_sr | FLOAT | non_boundary_runs / (balls_faced - (fours + sixes)) * 100 |
| bpb | FLOAT | balls_faced / (fours + sixes) |
| bp4 | FLOAT | balls_faced / fours |
| bp6 | FLOAT | balls_faced / sixes |
| balls_faced_pct | FLOAT | batter balls_faced / total innings balls * 100 |

**Team-relative metrics — batter minus team, positive = outperformed**
| Column | Type | Notes |
|---|---|---|
| team_relative_sr | FLOAT | |
| team_relative_dot_pct | FLOAT | |
| team_relative_bpb | FLOAT | |
| team_relative_non_boundary_sr | FLOAT | |

**Window-relative metrics — batter minus team for batter's window, positive = outperformed**
| Column | Type | Notes |
|---|---|---|
| window_relative_sr | FLOAT | |
| window_relative_dot_pct | FLOAT | |
| window_relative_bpb | FLOAT | |
| window_relative_non_boundary_sr | FLOAT | |

---

### Table: innings_bowlers
*One row per bowler per innings. Super over innings excluded.*
PK: `(match_id, innings_number, bowler_id)`

**TABLE RULE: Lookup and count only. Never aggregate calculations across rows. For any cross-innings calculation always use `deliveries`.**

**Identity**
| Column | Type | Notes |
|---|---|---|
| match_id | VARCHAR | |
| innings_number | INTEGER | 0-based |
| bowler | VARCHAR | |
| bowler_id | VARCHAR | |

**Innings context**
| Column | Type | Notes |
|---|---|---|
| first_over | FLOAT | First over bowled — 0-based, cricket convention |
| last_over | FLOAT | Last over bowled — 0-based, cricket convention |
| spell_count | INTEGER | Total spells in this innings |

**Raw counting stats**
| Column | Type | Notes |
|---|---|---|
| overs_bowled | FLOAT | Cricket convention e.g. 3.4. Display with ROUND(overs_bowled,1). Never use in arithmetic — use balls instead. |
| balls | INTEGER | Legal deliveries only |
| runs_conceded | INTEGER | SUM(runs_batter + noballs + wides) |
| wide_runs | INTEGER | SUM of wides column |
| noball_runs | INTEGER | SUM of noballs column |
| dots | INTEGER | |
| fours | INTEGER | Count of boundary 4s hit |
| sixes | INTEGER | Count of boundary 6s hit |
| maidens | INTEGER | Complete overs where SUM(runs_batter + wides + noballs) = 0 |
| wickets | INTEGER | Bowler-attributed wickets only |
| wickets_bowled | INTEGER | |
| wickets_lbw | INTEGER | |
| wickets_caught | INTEGER | |
| wickets_caught_and_bowled | INTEGER | |
| wickets_stumped | INTEGER | |
| wickets_hit_wicket | INTEGER | |

**Derived single-innings metrics**
| Column | Type | Notes |
|---|---|---|
| economy | FLOAT | runs_conceded / overs_bowled |
| per_ball_economy | FLOAT | runs_conceded / balls |
| sr | FLOAT | balls / wickets — NULL if wickets = 0 |
| dot_pct | FLOAT | dots / balls * 100 |
| boundary_pct | FLOAT | ((fours*4) + (sixes*6)) / runs_conceded * 100 |

**Team-relative metrics — bowler minus team**
| Column | Type | Notes |
|---|---|---|
| team_relative_economy | FLOAT | negative = outperformed |
| team_relative_per_ball_economy | FLOAT | negative = outperformed |
| team_relative_dot_pct | FLOAT | positive = outperformed |
| team_relative_sr | FLOAT | negative = outperformed |

---

### Table: bowling_spells
*One row per spell per bowler per innings. Child of innings_bowlers. Super over innings excluded.*
PK: `(match_id, innings_number, bowler_id, spell_number)`

**TABLE RULE: Lookup and count only. Never aggregate calculations across rows. For any cross-innings calculation always use `deliveries`.**

**Spell break:** gap of 3+ over numbers = new spell. Gap of 1 or 2 = same spell continues.

| Column | Type | Notes |
|---|---|---|
| match_id | VARCHAR | |
| innings_number | INTEGER | 0-based |
| bowler | VARCHAR | |
| bowler_id | VARCHAR | |
| spell_number | INTEGER | 1-based within innings |
| first_over | FLOAT | 0-based, cricket convention |
| last_over | FLOAT | 0-based, cricket convention |
| overs_bowled | FLOAT | Cricket convention. Display with ROUND(overs_bowled,1). |
| balls | INTEGER | Legal deliveries only |
| runs_conceded | INTEGER | SUM(runs_batter + noballs + wides) |
| wide_runs | INTEGER | |
| noball_runs | INTEGER | |
| dots | INTEGER | |
| fours | INTEGER | Count of boundary 4s |
| sixes | INTEGER | Count of boundary 6s |
| maidens | INTEGER | |
| wickets | INTEGER | Bowler-attributed only |
| economy | FLOAT | |
| per_ball_economy | FLOAT | |
| sr | FLOAT | NULL if wickets = 0 |
| dot_pct | FLOAT | |
| boundary_pct | FLOAT | ((fours*4)+(sixes*6)) / runs_conceded * 100 |

---

## SCRIPTS REFERENCE

| Script | Purpose |
|---|---|
| `ingest.py` | ✅ Full production ingestion — all 17 tables, incremental, transactional |
| `migrate_phase5.py` | Phase 5 migration — complete, keep for reference |
| `ingest_test_4.py` | Test ingestion — 50 files into `cricket_test_4.duckdb` — confirmed working |
| `ingest_test_3.py` | Baseline test — 50 files, no Phase 5 tables — keep for reference |
| `find_edge_cases.py` | Scans JSON files to identify edge case filenames |
| `diagnose_failures.py` | Inspects failed files for PK violations |

### Sanity check constants (in ingest.py)
Hardcoded — flag if any of these change:
- `wi_ prefix matches == 25`
- `bowl_out matches == 2`
- `wicket_count=2 deliveries == 10`

---

## ADDING NEW CRICSHEET FILES

1. Drop new `.json` files into `/Users/tarutr/Desktop/Cricket_DB/cricsheet_json_data/`
2. Run: `python3 ingest.py`
3. Script skips all already-ingested files automatically
4. All 17 tables populated for new files
5. Check `ingest.log` for results

---

## QUERYING TIPS

- **Excluding wides from batter stats:** `WHERE wides IS NULL`
- **Excluding no-balls from bowler economy:** `WHERE wides IS NULL AND noballs IS NULL`
- **Bowler-attributed wickets only:** exclude `kind IN ('run out', 'retired hurt', 'retired out', 'obstructing the field', 'handled the ball', 'hit the ball twice', 'timed out')`
- **over_number is 0-based** — overs 1–6 powerplay = `over_number BETWEEN 0 AND 5`. Always subtract 1.
- **Multi-wicket deliveries** — use `wickets` table when `wicket_count > 1`
- **Season filtering** — use `season_year_start` / `season_year_end`
- **Series identification** — use `event_name` + `season`. Reliable for post-2017 only.
- **Afghanistan** — not in Cricsheet data. All Afghanistan queries return zero results.
- **Player names** — stored as initials + surname. Search by surname.
- **Team name variants** — some franchises renamed across seasons. Use `IN` clause.
- **innings_batters / innings_bowlers / bowling_spells** — lookup and count only. Never aggregate calculations. Use `deliveries` for cross-innings calculations.
- **is_not_boundary** — TRUE = 4 or 6 scored by running. NULL = boundary hit or no boundary. Only 1,285 TRUE values in entire dataset.
- **non_boundary_sr** — denominator is (balls_faced - (fours + sixes)), not balls_faced.
- **Team-relative metrics** — batter: positive = outperformed. Bowler: economy/SR negative = outperformed, dot_pct positive = outperformed.
- **Super overs** — excluded from innings_batters, innings_bowlers, bowling_spells. Query `deliveries` directly for super over data.
- **overs_bowled** — cricket convention (3.4 = 3 overs and 4 balls). Always display with ROUND(overs_bowled,1). Never use in arithmetic — use `balls` instead.

---

## FUTURE TO-DOS (NO PHASE ASSIGNED)

### `team_registry` normalisation table
**Problem:** Some franchises renamed across seasons (e.g. "Royal Challengers Bangalore" → "Royal Challengers Bengaluru"). Multi-season team queries require `IN` clauses.
**Blocker:** Cannot be built from JSON data alone — requires manually curated mapping.

### `common_name` in `player_registry`
**Problem:** Player names stored as initials + surname. First-name search returns nothing.
**Blocker:** No source of truth for common names in the JSON data. Requires curated mapping.

---

## PHASE 6 — ESPN DATA INTEGRATION

### Status: In Progress (Step 1 of 13 complete)

---

### ⚠️ WORKING RULES — PHASE 6

These rules apply to all work in this phase, and all phases. This is a reiteration for clarity.

1. **All work outside production.** Every step in this pipeline is to be done and validated completely outside the main production `cricket.duckdb`. The production database is not touched until Step 13, and only when every prior step has been fully validated.
2. **No assumptions, ever.** Only state something as fact if it came from validated data or explicit user confirmation. If uncertain, label it **[UNVALIDATED — needs inspection]** and stop until confirmed.
3. **Cite the source of every claim.** Every factual statement must trace to one of: "validated from data", "user confirmed", or "from reference file".
4. **Validate before designing.** No schema decisions, no script writing, no recommendations until the relevant data has been inspected and findings confirmed.
5. **One step at a time.** The sequence is always: inspect → confirm → move forward. Never skip a step.
6. **Never reference external documentation.** Only use what is observed in the actual data files or explicitly confirmed by the user.
7. **Flag contradictions explicitly.** If something in the ESPN data conflicts with Cricsheet or a prior finding, stop and flag it immediately. Never silently resolve a contradiction.
8. **More data is better, not worse.** Where ESPN and Cricsheet cover the same matches, both sources are retained. Missing data from one source can be supplemented by the other. Only contradictory data — where the two sources disagree on the same fact — is flagged for review.

---

### What we've done

Explored and profiled the ESPN Ganjoo dataset (downloaded 6 May 2026) stored at `/Users/tarutr/Desktop/Cricket_DB/other_data/ESPN_Ganjoo_6_May_26/`. Created a lightweight exploration DuckDB instance (`espn_explore.duckdb`) in the same folder with views over all CSVs — no ingestion, no schema, just queryable pointers to the raw files.

---

### What we've learnt

**Files and coverage:**

| File | Rows | Matches | Date Range | Notes |
|---|---|---|---|---|
| aucb_bbb.csv | 1,527,407 | 4,065 | 2019–2026 | Richest schema. Male only. T20 Domestic-heavy (T20 Blast, IPL, BBL, CPL), plus internationals and The Hundred. |
| t20_bbb.csv | 2,244,702 | 9,882 | 2015–2026 | Male T20s. Most comprehensive T20 coverage. Simpler schema. |
| odi_bbb.csv | 1,630,053 | 3,213 | 2000–2026 | Male ODIs. Deepest historical coverage. Large chunk with no competition name. |
| test_bbb.csv | 2,143,624 | 1,107 | 1999–2026 | Male Tests. Last updated January 2026. |
| womens_t20_bbb.csv | 658,190 | 2,930 | 2018–2026 | Women's T20 only. T20I, WBBL, Women's Hundred, WPL. |
| t20i_batting_innings.csv | 83,118 | 3,807 | Unknown | Scorecard-level batting aggregations. Richer match context. Updated less frequently. |
| t20i_bowling_innings.csv | 45,214 | 3,807 | Unknown | Scorecard-level bowling aggregations. Same matches as batting innings file. |

**Key schema findings (aucb vs Cricsheet):**

What aucb has that Cricsheet doesn't:
- Shot direction (`shotAngle` 0-360°, polar coordinates, 99.6% populated) — direction the ball was hit measured in degrees clockwise from straight down the ground
- Fielding position (37 distinct positions, 98.6% populated) — which fielder was most relevant to the delivery; cross-references shot direction and gives soft distance information for non-boundaries
- Ball-by-ball boolean flags: `isFreeHit`, `isPowerPlay`, `isBattingPowerPlay`, `isNewBall`, `isReferred`, `isAppeal`, `isFloodLit` — all 100% populated
- `control` — binary 0/1 shot control flag, 100% populated (0 = uncontrolled, 1 = controlled)
- `commentary` — fully structured natural language description of every delivery, 100% populated
- Player DOB and nationality on every delivery (`battingPlayerDob`, `battingPlayerCountry` etc.) — directly usable for building player registry
- Exact ball timestamps (`ballDateTime`)
- DRS tracking (`isReferred`, `isAppeal`, `referralOutcomeId`)
- Catch difficulty rating — sparse, 1.2% populated, only for catching opportunities. Scale 0-3.
- `shotMagnitude` — distance ball travelled from bat in arbitrary units. Useful for relative comparisons only, not absolute distance. Units unknown.
- Coded fields (`lengthTypeId`, `lineTypeId`, `battingShotTypeId`, `bowlingDetailId` etc.) — need lookup tables to decode, not yet investigated
- `batruns` — runs scored by batter on delivery (same as runs_batter in Cricsheet)
- `bowlruns` — runs charged to bowler on delivery (includes no-balls and wides, excludes byes/leg-byes). Equivalent to per-delivery contribution to runs_conceded in Cricsheet.

**Coverage relationship between ESPN and Cricsheet:**
ESPN and Cricsheet are complementary rather than competing sources. Neither is a superset of the other. Cricsheet has stronger associate nation and women's cricket coverage, and more reliable international coverage for the last ~10 years, with IPL data going back to its start. ESPN has richer ball-by-ball schema for the matches it covers (particularly 2019+ via aucb), deeper historical ODI and Test data, and broader domestic T20 coverage. Where both sources cover the same match, both are retained — additional data points make the database more comprehensive. Only contradictory data — where the two sources disagree on the same fact — is flagged for review.

**Querying ESPN data with coverage disclaimers:**
When a query relies on fields that are not universally populated (e.g. shot type, wagon wheel), results must be returned with a coverage denominator. Example: "45% of Kohli's runs since 2022 came from back-foot shots (203/245 innings have shot data)." Never return a statistic from a partially-populated field without flagging the coverage gap.

**Overlap between aucb and format-specific files:**
- ODI: 587/603 aucb matches found in odi_bbb (97%)
- Test: 226/270 found in test_bbb (84%) — gaps mainly NZ home series and recent Ashes
- T20: 2,889/3,192 found in t20_bbb (90%) — gaps mainly The Hundred, MLC, some CPL/international

Gaps are due to a mix of: team name variants (India Men vs India, Royal Challengers Bengaluru vs Bangalore, Saint Lucia Kings vs St Lucia Kings), competitions not covered in format files (The Hundred, Tamil Nadu Premier League), and genuine missing series.

**ID systems:**
- aucb uses small integer `fixtureId` (e.g. 17198)
- Format-specific files use large integer `p_match` (e.g. 1348656)
- These are different ESPN ID systems — not directly joinable
- Cricsheet uses hex IDs (e.g. `7f3f5e0b`)
- All three systems require date + team name matching to cross-reference

---

### New files created

| File | Location | Purpose |
|---|---|---|
| espn_explore.duckdb | `/Users/tarutr/Desktop/Cricket_DB/other_data/ESPN_Ganjoo_6_May_26/` | Lightweight exploration DB with views over all 7 CSVs |

---

### To do (in order)

1. ✅ Understand ESPN data
2. Build ESPN player registry
3. Find a way to map to Cricsheet player registry
4. Scrape total data from ESPN player pages
5. Validate match and BBB data across CSVs and compared to Cricsheet data
6. Build methodology for using unclear categories (shot angle, shot magnitude, control etc.)
7. Build lookup tables for new categories in ESPN data
8. Team name normalisation
9. Build and map match ID data across ESPN/Cricsheet
10. Identify how we can add ESPN data to Cricsheet data reliably
11. Test combination outside DuckDB
12. Find a way to API ESPN data directly to DuckDB
13. Combine data using an updated ingest.py. Run an automated cycle (once/twice a day)

---

### Known data gaps (source limitations)

| Gap | Detail |
|---|---|
| No women's ODI or Test | Not present anywhere in the ESPN dataset |
| aucb limited to 2019+ | Richer schema not available for historical data |
| Some NZ home series missing | From odi_bbb and test_bbb — present in aucb where covered |
| The Hundred not in t20_bbb | Covered in aucb only |
| USA and associate nation gaps | Inconsistent coverage across format files |
| Team name variants | India Men/India, RCB name change, Saint Lucia/St Lucia etc. — not yet normalised |
| Two ESPN ID systems | aucb fixtureId ≠ format file p_match — mapping not yet built |
| shotMagnitude units unknown | Arbitrary units — relative comparisons only, not absolute distance |
| Coded field lookup tables | lengthTypeId, lineTypeId, battingShotTypeId etc. not yet decoded |

---

## PHASE 7 — STREAMLIT FRONTEND (PLANNED)

### Architecture — two tabs

**Tab 1 — Dashboard**
- Pre-built views with dropdown filters (match type, team, date range)
- No AI — hardcoded SQL queries
- Suggested views: top run scorers, top wicket takers, team records, recent matches

**Tab 2 — AI Query + Charts**
- Plain English → Claude clarifies ambiguities → user confirms → SQL runs → result as table
- "Visualise this" button on any result → Plotly chart rendered inline
- Player name search: type partial surname → results appear when fewer than 5 matches → click to select
- Branding: consistent colour scheme + watermark on every chart

### AI chatbot behaviour (hardcoded via system prompt)
- Always clarify before running — never assume
- Never reference a table or column not in the schema
- On query failure: explain, stop, wait for user — no automatic retry
- over_number is 0-based — always account for this
- Afghanistan not in data — say so immediately
- innings_batters / innings_bowlers / bowling_spells — lookup and count only
- Player names are initials + surname — remind user to search by surname
- overs_bowled — never use in arithmetic, use balls column instead
- Super overs excluded from summary tables

### Chart branding
- Consistent colour scheme — to be chosen at build time
- Watermark on every Plotly chart — to be specified at build time

---

## NEXT STEPS

1. Continue Phase 6 — ESPN Data Integration (Step 2: Build ESPN player registry)
