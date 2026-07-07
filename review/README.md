# How to resolve `ambiguous_matches.csv`

Each row is one **proposed pairing**: a database player (left columns, `db_`) against
one candidate from the Cricinfo sheet (right columns, `sheet_`). A database player with
three candidates appears as three rows. Your job is to say, per row, whether the pairing
is the same real person.

## What to write in the `resolution` column

| write | meaning |
|---|---|
| `YES` | this row's database player and sheet player are the same person — link them |
| `NO` | definitely different people — never link these two |
| `NONE` | I checked this database player and **no** sheet candidate is right (they get no profile). Write it on any one of the player's rows. |
| *(blank)* | undecided — skip for now, come back anytime. Blank rows are simply not matched (safe default). |

`resolution_note` is free text, entirely optional — write anything that helps future-you
("same guy, ESPN has him under his full name", "gender wrong in Cricsheet", etc.).

Your decisions are **permanent**: in Phase D2 they are encoded into
`review/manual_matches.csv`, which every automated rebuild applies last, forever —
sheet updates can never overwrite them.

## Your specific scenarios

- **Plain mismatch** → `NO` (or leave blank; `NO` is better because it's remembered
  forever and the pair will never be re-proposed).
- **Female player wrongly tagged male in Cricsheet (or vice versa)** → if the sheet
  candidate IS that same person, write `YES` — a manual `YES` outranks the automatic
  gender guard. Use the note column to record the gender-tag error.
- **One real person split into two database entries (played for two international
  teams)** → write `YES` on BOTH database players' rows against the same sheet
  candidate. Both entries will carry that person's profile. (Their *stats* stay
  separate on the site — merging Cricsheet IDs is a bigger, separate decision; tell me
  if you want that and I'll scope it.)
- **Same name, genuinely two different people** (e.g. the two RG Sharmas) → `YES` on
  the correct row, `NO` on the wrong one.

## Columns added to help you check

- `sheet_playercard_url` — the player's ESPNcricinfo page, one click to verify.
- `sheet_intl_innings` — the sheet's ODI + T20I innings count (batting + bowling).
- `sheet_club_t20_innings` — the sheet's domestic T20 innings count (batting + bowling).
  ⚠️ Caveat: the sheet has **no Test / first-class / domestic 50-over columns**, so
  these counts undercount red-ball and List-A careers. Use as a sniff test, not gospel.
- `db_intl_matches` / `db_club_matches` — the same split from our own database
  (all formats), for side-by-side comparison.

## Row types (`ambiguity_type`), most important first

- `B_sheet_name_country_collision` — two+ sheet rows share name+country; pick which is
  your player (the biggest stars are here — resolve these first).
- `A_db_name_collision` — two+ database players share a name that hit a sheet row.
- `C_exact_unique_evidence_failed` — name matches exactly but country/teams disagreed.
- `D_female_db_vs_male_sheet` — women's-matches-only database player hit a men-only
  sheet name (your gender-tag-error cases live here).
- `E_both_gender_id_held_by_owner` — the 10 IDs appearing in both men's and women's
  matches, held at your request.

Edit the file in Excel/Numbers/Google Sheets, keep it as CSV, and either commit it or
just tell me when it's ready and I'll take it from there. You don't have to finish in
one sitting — blanks are always safe.
