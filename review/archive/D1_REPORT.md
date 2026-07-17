# Phase D1 — Explore & Report (READ-ONLY)

**Date:** 2026-07-07 · **Author:** data engineer (cricdb)
**Scope:** Profile the Cricinfo profiles sheet, measure coverage against the database,
propose (not finalise) a matching-tier scheme, and hand the owner two review CSVs.
No database, source-data, or site code was modified. The DB was opened read-only.

**Reproducible script:** `analysis/d1_explore.py` (run: `python3 analysis/d1_explore.py`).
Every number below is emitted by that script from live queries; nothing is hand-typed
from memory.

**Inputs used**
- `source_data/cricinfo_player_profiles.csv` — 14,858 data rows, unique `player_id`.
- `data/cricket.duckdb` — 17-table schema per `reference/db_reference.md`.

**Owner-confirmed facts applied**
- Sheet is **men-only by design**. Its 3 `gender=F` rows are typos and were treated as M:
  Samiullah Rahmani (Sweden), SC van Schalkwyk (Shadley Claude van Schalkwyk, USA),
  Kawalpreet Singh (India). (Validated: exactly these 3 F rows exist.)
- Per-format innings-count columns are **not** career stats; career features are shelved.
- Matching must never silently guess below the confident tier.

---

## 1. Sheet profile

### 1.1 Shape
- **Rows:** 14,858 (header present; row count excludes header).
- **Columns:** 63. `player_id` is unique (14,858 distinct).
- **Gender:** M = 14,855, F = 3 (the 3 confirmed typos → treated as M).

### 1.2 Full column list with inferred types
Types are DuckDB's inference over the whole file (`sample_size=-1`). `player_id` infers as
BIGINT but is used as text for joins. Full-varchar read gives identical structure.

| # | column | type | | # | column | type |
|---|---|---|---|---|---|---|
| 1 | player_id | BIGINT | | 33 | all_styles | VARCHAR |
| 2 | display_name | VARCHAR | | 34 | major_team_ids | VARCHAR |
| 3 | full_name | VARCHAR | | 35 | major_team_names | VARCHAR |
| 4 | short_name | VARCHAR | | 36 | major_team_abbreviations | VARCHAR |
| 5 | first_name | VARCHAR | | 37 | headshot_url | VARCHAR |
| 6 | middle_name | VARCHAR | | 38 | flag_url | VARCHAR |
| 7 | last_name | VARCHAR | | 39 | playercard_url | VARCHAR |
| 8 | batting_name | VARCHAR | | 40 | news_ref | VARCHAR |
| 9 | fielding_name | VARCHAR | | 41 | guid | VARCHAR |
| 10 | gender | VARCHAR | | 42 | uid | VARCHAR |
| 11 | is_active | BOOLEAN | | 43 | profile_ref | VARCHAR |
| 12 | active | BOOLEAN | | 44 | debut_count | BIGINT |
| 13 | age | BIGINT | | 45 | debut_refs | VARCHAR |
| 14 | date_of_birth | VARCHAR | | 46 | relation_count | BIGINT |
| 15 | date_of_death | VARCHAR | | 47 | relation_types | VARCHAR |
| 16 | height | DOUBLE | | 48 | related_player_ids | VARCHAR |
| 17 | weight | BIGINT | | 49 | birth_place_raw | VARCHAR |
| 18 | country_id | BIGINT | | 50 | appears_as_batter | BOOLEAN |
| 19 | country_name | VARCHAR | | 51 | appears_as_bowler | BOOLEAN |
| 20 | country_abbreviation | VARCHAR | | 52 | source_formats | VARCHAR |
| 21 | current_team_id | BIGINT | | 53 | source_batting_formats | VARCHAR |
| 22 | current_team_name | VARCHAR | | 54 | source_bowling_formats | VARCHAR |
| 23 | current_team_abbreviation | VARCHAR | | 55 | odi_batting_innings_count | BIGINT |
| 24 | current_team_location | VARCHAR | | 56 | odi_bowling_innings_count | BIGINT |
| 25 | current_team_is_national | BOOLEAN | | 57 | t20i_batting_innings_count | BIGINT |
| 26 | position_id | VARCHAR | | 58 | t20i_bowling_innings_count | BIGINT |
| 27 | position_name | VARCHAR | | 59 | t20_batting_innings_count | BIGINT |
| 28 | position_abbreviation | VARCHAR | | 60 | t20_bowling_innings_count | BIGINT |
| 29 | batting_style | VARCHAR | | 61 | source_total_batting_innings | BIGINT |
| 30 | batting_style_short | VARCHAR | | 62 | source_total_bowling_innings | BIGINT |
| 31 | bowling_style | VARCHAR | | 63 | source_file_count | BIGINT |
| 32 | bowling_style_short | VARCHAR | | | | |

Columns 55–63 are the **per-format innings-count / source-count** fields. Per owner
decision these are **not** treated as career stats and are **not** used anywhere in D1.
Noted as present; nothing more.

### 1.3 Null / blank rates for fields of interest
Blank = SQL NULL after CSV read (the underlying cells are genuinely empty, not the
literal string `nan`; verified against the raw file).

| field | blank rows | blank % |
|---|---:|---:|
| batting_name | 0 | 0.00% |
| full_name | 0 | 0.00% |
| country_name | 0 | 0.00% |
| date_of_birth | 369 | 2.48% |
| position_name | 0 | 0.00% |
| batting_style | 422 | 2.84% |
| bowling_style | 2,654 | 17.86% |
| major_team_names | 117 | 0.79% |
| headshot_url | 0 | 0.00% |

**headshot_url caveat:** the field is never blank, but **13,110 of 14,858 (88.2%)** point
at the ESPN default-player placeholder (`…/default-player-logo-500.png`). Only **1,748
(11.8%)** are real headshots. For D5's profile pop-ups, "has an image" ≈ 12%, not 100%.
(`date_of_death` is populated for 168 rows — deceased players.)

### 1.4 Filter vocabularies — verbatim distinct values with counts
These become UI filter vocabularies; reproduced verbatim, no editing. Also written to
`analysis/vocab_position_name.csv`, `analysis/vocab_batting_style.csv`,
`analysis/vocab_bowling_style.csv`.

**position_name** (11 values; blank = 0)

| count | value |
|---:|---|
| 9,013 | Unknown |
| 1,995 | Bowler |
| 979 | Allrounder |
| 487 | Wicketkeeper batter |
| 474 | Batter |
| 459 | Top-order batter |
| 432 | Middle-order batter |
| 413 | Opening batter |
| 240 | Bowling allrounder |
| 217 | Batting allrounder |
| 149 | Wicketkeeper |

> 60.7% of rows have `position_name = "Unknown"`. As a filter, position is missing for
> most players. Flag for owner: is "Unknown" a real filter option or a hide-from-filter?

**batting_style** (2 non-blank values; 422 blank)

| count | value |
|---:|---|
| 11,336 | Right-hand bat |
| 3,100 | Left-hand bat |
| 422 | *(blank)* |

**bowling_style** (20 non-blank values; 2,654 blank)

| count | value |
|---:|---|
| 3,200 | Right-arm medium |
| 2,785 | Right-arm offbreak |
| 1,557 | Right-arm medium-fast |
| 1,329 | Slow left-arm orthodox |
| 961 | Right-arm fast-medium |
| 767 | Legbreak |
| 342 | Left-arm medium |
| 339 | Legbreak googly |
| 284 | Right-arm fast |
| 248 | Left-arm medium-fast |
| 181 | Left-arm fast-medium |
| 72 | Left-arm wrist-spin |
| 44 | Right-arm bowler |
| 40 | Left-arm fast |
| 26 | Right-arm slow-medium |
| 14 | Right-arm slow |
| 7 | Left-arm slow |
| 5 | Left-arm bowler |
| 3 | Left-arm slow-medium |
| — | 2,654 blank |

> "Right-arm bowler" / "Left-arm bowler" (49 rows total) are pace/spin-unknown — they
> will not fit a clean pace-vs-spin normalisation in D2/D4. Flag for owner.

---

## 2. Coverage analysis

### 2.1 Active DB players and the 0-ball edge
- **Active DB player** (task definition = appears as `batter_id` OR `bowler_id` in ≥1
  `deliveries` row): **13,118**. (All 13,118 exist in `player_registry`; none missing.)
- **non_striker-only players** (appear as `non_striker_id` but never as batter or
  bowler — 0-ball crease appearances): **13 additional** player_ids.
  → **Owner decision needed:** are these 13 "active" for profile purposes? They never
  faced or bowled a ball. The current definition excludes them; flagged, not resolved.
- **Note on super overs:** the task's "active" definition is literal presence in
  `deliveries` and does not mention super-over exclusion, so super-over-only appearances
  would count as active here. `reference/db_reference.md` excludes super overs from
  aggregate *stats*, not from this presence definition. No contradiction; noted.

### 2.2 Gender / team-type / recency mix of active players
From `match_players` joined to `matches` (a player's gender/team_type is taken from the
matches they actually played, not assumed):

| dimension | breakdown |
|---|---|
| gender | male-only **9,824**; female-only **3,284**; **both genders 10**; neither 0 |
| team_type | international-only 6,958; club-only 4,266; both 1,894 (→ any-intl 8,852) |
| recency | last match ≥ 2023-01-01: **7,906**; before: 5,212 |

**⚠️ Data fact the owner must see — 10 players appear in BOTH men's and women's
matches** (validated, not assumed). Because Cricsheet `player_id` is a source hex ID,
these are almost certainly ID collisions between two different real people who share a
name, rather than one person playing both. They are men-only-sheet-relevant only for
their men's portion:

| registry name | player_id | men's matches | women's matches |
|---|---|---:|---:|
| Hassan Nawaz | 26a8b2fe | 71 | 1 |
| N Joshi | cfece11f | 1 | 26 |
| N Sharma | 764f35d8 | 12 | 8 |
| S Ravikumar | 5597338d | 12 | 2 |
| C Smith | c160db98 | 6 | 6 |
| AG Rao | 0420f51f | 2 | 9 |
| Dilum Fernando | f6ba97c6 | 3 | 2 |
| N Magagula | 3a54c25b | 1 | 3 |
| Song Yangyang | cf33e1ce | 1 | 2 |
| SD Bates | f5e8e3d2 | 1 | 1 |

→ **Owner decision needed:** treat these 10 as men (they have men's matches) for profile
matching? They are currently eligible for Tier-1 (they satisfy `is_male=1`).

### 2.3 Tier-1 (confident) match rate among active players
Match universe for the headline rate is **male** active players (the sheet is men-only);
the overall-including-women figure is reported too, as requested.

| segment | matched / total | rate |
|---|---|---:|
| **overall (incl. women)** | 7,050 / 13,118 | **53.7%** |
| **male-only** | 7,050 / 9,834 | **71.7%** |
| female-only | 0 / 3,284 | **0.0%** |
| international (any) | 4,880 / 8,852 | 55.1% |
| club-only | 2,170 / 4,266 | 50.9% |
| recent (≥ 2023-01-01) | 4,448 / 7,906 | 56.3% |
| earlier | 2,602 / 5,212 | 49.9% |
| **male + international** | 4,880 / 6,063 | **80.5%** |
| male + club-only | 2,170 / 3,771 | 57.5% |
| male + recent | 4,448 / 5,520 | 80.6% |
| male + earlier | 2,602 / 4,314 | 60.3% |

Reading: for the group that matters most — **male international players — 80.5% get a
confident match**, and male recent (any type) is 80.6%. Club players drag the overall
male rate down to 71.7% because many club-only players have weak country evidence. Women
are 0.0% by construction (see §3 gender guard); this is the correct, expected number.

### 2.4 Sheet players with no DB presence
- Sheet rows whose `batting_name` matches **no** `player_registry.player_name` (exact):
  **6,478 / 14,858 (43.6%)**.
- Sheet rows matching no exact **active** registry name: **6,684 / 14,858 (45.0%)**.

Expected and fine — the sheet is a broad Cricinfo dump covering players Cricsheet never
recorded. These are excluded from site outputs in D2 per owner constraint. (This is a
loose name-only test; the true "no DB presence" count could differ slightly once fuzzy
name variants are resolved, but the order of magnitude — roughly 6.5k — is solid.)

---

## 3. Matching-tier proposal (PROPOSE — owner approves at the gate)

**Global gender guard (proposed, correctness-critical).** Because the sheet is men-only,
**Tier-1 requires the DB player to have played ≥1 men's match** (`is_male = 1`). Without
this guard, 18 female-only DB players exact-matched a men-only sheet row on name, and 8
of them even passed country evidence — all false positives (e.g. DB female-only
"M Sert"/Turkey matched to sheet's *Mehmat Sert*, a man; "SK Yadav"/India matched to
*Sujit Kumar Yadav*, a man). The guard sends all 18 to the review file instead
(ambiguity type D). **This is the single most important correctness decision in D1 and
needs owner sign-off.**

### 3.1 Tier definitions and counts

| tier | auto-match? | evidence required | pairs captured |
|---|---|---|---|
| **Tier 1a** — intl exact | YES | `batting_name` == `player_name`, name UNIQUE on both sides, DB player played ≥1 men's match, DB player is international, AND sheet `country_name` equals one of the international teams the player appears for in `match_players` | **4,880** |
| **Tier 1b** — club-only exact | YES | Same exact-unique-both-sides + men's guard, but DB player is **club-only** (no intl team ⇒ no country evidence); require **overlap** between sheet `major_team_names` and the DB teams the player played for | **2,170** |
| **Tier 1 total** | YES | union of 1a + 1b | **7,050** (7,050 distinct player_ids — strictly 1:1) |
| F1 — normalised-equal | **NO** | case/diacritic/punctuation-normalised name equality, but NOT byte-exact (e.g. `S Fouché`↔`S Fouche`, `M De Villiers`↔`M de Villiers`, `Mohammad Nawaz (3)`↔`Mohammad Nawaz(3)`) | 8 pairs (8 pids) |
| F3 — initials+surname+country | **NO** | same surname token, sheet country consistent with intl team(s), AND DB initials letter-set == initials derived from sheet `full_name` given names | 563 pairs / 310 pids (**245 pids have a single candidate**) |
| F2 — surname+country | **NO** | same surname token + sheet country consistent with intl team(s) only (loose net; many candidates per player) | 5,508 pairs / 518 pids |

**Tier-1 evidence, stated precisely.** A pair is Tier-1 iff ALL of:
1. `sheet.batting_name` == `registry.player_name` byte-for-byte;
2. that name occurs exactly once in `player_registry` AND exactly once in the sheet;
3. the DB player has ≥1 men's match;
4. **either** (1a) the DB player is international and `sheet.country_name`
   (case-insensitive) is among the international teams they appeared for,
   **or** (1b) the DB player is club-only and normalised `sheet.major_team_names`
   overlaps the DB teams they played for.

**Club-only bucket, quantified (as requested).** Exact-unique-both club-only candidates
= **2,539**; of these, **2,170 (85%)** clear the team-overlap requirement and become
Tier-1b. The remaining **369** exact-unique-both club-only pairs fail team overlap and
are held out (they land in ambiguity type C, below, together with intl near-misses).
Recommendation: keep the team-overlap requirement for club-only — bare exact-unique
club names without any team evidence are the weakest signal in the whole set and are
exactly where different amateurs share a name.

**Near-miss holdout.** Exact-unique-both pairs that fail their evidence check total
**429** (intl country mismatch + club team-overlap failures). These are NOT auto-matched;
they go to the review file (type C) for the owner, since an exact-unique name is strong
but evidence-inconsistent and could be a genuine data mismatch or a stale sheet country.

### 3.2 Fuzzy sample for owner eyeballing
`review/fuzzy_sample_20.csv` — exactly 20 candidate pairs spanning the patterns:
F1 (diacritic/case/punctuation), F3 (spelling/transliteration variants like
`Mehedi`↔`Mehidy Hasan Miraz`, `Nazmul`↔`Najmul Hossain Shanto`, `BJ McMullen`↔
`B McMullen`), and F2 (surname+country only, e.g. `L Tucker`↔`LJ Tucker`,
`James Bracey`↔`JR Bracey`). The sample deliberately **includes false candidates** so the
owner sees why these are never auto-matched: e.g. F3 pairs `Anamul Haque`↔`Ariful Haque`
and `Naeem Islam`↔`Nahidul Islam` share initials+country but are **different players**.

---

## 4. Ambiguous / duplicated-name handling

### 4.1 Counts
- Sheet `batting_name`+`country_name` pairs duplicated within the sheet: **171**
  (this reproduces the owner's stated 171 exactly — good cross-check).
- DB duplicate `player_name`s among **active** players: **153** names.
- Any such collision is automatically ambiguous → review file, never auto-matched.

### 4.2 `review/ambiguous_matches.csv` — 1,332 rows, four ambiguity types
Each row carries advisory disambiguation columns (`db_teams`, `db_matches`,
`db_last_match`, `sheet_country`, `sheet_major_teams`, `sheet_dob`, `db_reg_name_count`),
sorted most-recent / most-played first for the owner to hand-decide.

| type | rows | meaning |
|---|---:|---|
| A_db_name_collision | 607 | DB active player whose `player_name` is duplicated among active registry rows, exact-hitting a sheet row → the *DB target* is ambiguous |
| C_exact_unique_evidence_failed | 429 | exact-unique-both name, but country/team evidence failed → owner confirms |
| B_sheet_name_country_collision | 278 | sheet `batting_name`+`country` duplicated in sheet, exact-hitting a DB player → the *sheet source* is ambiguous |
| D_female_db_vs_male_sheet | 18 | female-only DB player exact-matched a men-only sheet row; excluded from Tier-1 by the gender guard |

Worked example (type B): registry `RG Sharma` (id `740742ef`, 779 matches, teams Mumbai
Indians / India / Deccan Chargers) matches **two** sheet rows both country=India — one is
Rohit Sharma (DOB 1987-04-30, Mumbai/India teams) and one a different RG Sharma (DOB
1983-11-07, Rajasthan). The advisory DOB + team columns let the owner pick Rohit
unambiguously. This is exactly why RG Sharma is held out of Tier-1.

### 4.3 `review/unmatched_active_players.csv` — 6,068 rows
All active DB players with no Tier-1 match. Columns: `player_id`, `player_name`, `gender`
(M / F / M+F), `team_types`, `teams_played_for` (top 4), `matches`, `last_match_date`,
plus the **best fuzzy candidate** if one exists (`best_candidate_tier`,
`n_fuzzy_candidates`, and the candidate's sheet name/country/teams/DOB). Preference order
for "best": F1 > F3 > F2. Sorted most-recent / most-played first. Female-only actives
appear here (they are unmatched) but get no candidate (men-only sheet).

---

## 5. Most important problem patterns

1. **Female-only DB ids collide with men-only sheet names (false-positive risk).**
   18 female-only DB players exact-match a sheet row; 8 pass country too. The gender
   guard fixes this but *must* be owner-approved — it's the difference between 0% and a
   polluted women's match rate.
2. **Sheet names are heavily duplicated for the biggest stars.** Rohit Sharma and other
   top players have 2+ sheet rows sharing name+country (171 such pairs). The most famous
   players are therefore in the *ambiguous* file, not auto-matched — the owner should
   resolve these first (they're the highest-visibility profiles).
3. **Club-only players have thin evidence.** 369 exact-unique club-only names have no
   team overlap at all; bare name equality there is unsafe. Team overlap is the only
   guardrail and it still leaves the club match rate at 57.5% (male).
4. **`position_name` is "Unknown" for 61% of the sheet and `headshot_url` is a
   placeholder for 88%.** Two of the richest-sounding profile fields are mostly empty in
   practice — relevant to D2/D5 expectations.
5. **Spelling/transliteration variants are systematic for South-Asian names**
   (`Mehedi`/`Mehidy`, `Nazmul`/`Najmul`, `Anamul`/`Ariful`). F3 surfaces both the true
   variants and true-different-player look-alikes, so these need human review — auto-
   matching here would silently swap players.

---

## 6. Definitional questions the owner must answer (blocking D2)

1. **Gender guard:** approve requiring `is_male=1` for Tier-1? (Recommended — prevents
   female-only ids matching the men-only sheet.)
2. **The 10 both-gender player_ids:** treat as men for matching (they have men's
   matches), or hold out as suspected ID collisions?
3. **The 13 non_striker-only (0-ball) player_ids:** count as "active" for profiles, or
   exclude (current behaviour)?
4. **Club-only Tier-1b:** keep the sheet-team ↔ DB-team overlap requirement, or accept
   bare exact-unique names for club-only players (adds ~369, lower confidence)?
5. **Type C (429 exact-unique, evidence-failed):** auto-match on the strength of an
   exact-unique name despite country/team mismatch, or keep them manual?
6. **`position_name = "Unknown"` (61%)** and **`bowling_style` "Right/Left-arm bowler"
   (pace/spin unknown):** how should these appear in the D4 filter vocabularies?
7. **Recency cutoff:** confirm 2023-01-01 as the "recent" boundary for the coverage split.

---

## 7. Files written (all absolute paths)

- `/Users/tarutr/Desktop/live_db/analysis/d1_explore.py` — reproducible analysis script.
- `/Users/tarutr/Desktop/live_db/analysis/vocab_position_name.csv`
- `/Users/tarutr/Desktop/live_db/analysis/vocab_batting_style.csv`
- `/Users/tarutr/Desktop/live_db/analysis/vocab_bowling_style.csv`
- `/Users/tarutr/Desktop/live_db/review/unmatched_active_players.csv` — 6,068 rows.
- `/Users/tarutr/Desktop/live_db/review/ambiguous_matches.csv` — 1,332 rows.
- `/Users/tarutr/Desktop/live_db/review/fuzzy_sample_20.csv` — 20 rows.
- `/Users/tarutr/Desktop/live_db/review/D1_REPORT.md` — this report.

**Nothing was auto-matched below Tier-1. STOP for owner review and manual resolutions.**
