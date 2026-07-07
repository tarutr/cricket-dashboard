# Owner decisions — player matching & data phases

Authoritative record of owner rulings. The D2 matcher implements exactly these; any
change requires a new owner decision recorded here. Dates are decision dates.

## 2026-07-07 — D1 gate decisions

1. **Gender guard: APPROVED.** The profiles sheet is men-only; a DB player must have
   played ≥1 men's match to be eligible for any automatic match. Female-only players
   can never auto-match a sheet row; name collisions go to review (type D).
2. **The 10 both-gender player_ids: HELD for owner review.** Not eligible for
   automatic matching; all 10 appended to `ambiguous_matches.csv` as type
   `E_both_gender_id_held_by_owner` (11 rows; C Smith has two sheet candidates;
   5 of the 10 have no exact sheet candidate at all, including Hassan Nawaz).
3. **Club-only team evidence: CONTAINMENT RULE.** Team overlap for club-only players
   uses normalized substring containment — "Essex 2nd XI" / "Surrey Under-19s" count
   as evidence for "Essex" / "Surrey". Adds ~85 confident matches (Tier-1c) over the
   strict rule. The ~279 truly disjoint cases stay manual (remain in type C).
4. **Exact-unique-name pairs that FAIL evidence (type C, 429 pre-containment): stay
   MANUAL.** Never auto-matched; owner resolves in the review file.

## 2026-07-07 — earlier same-day decisions (phase kickoff)

- **Sheet is men-only by design.** Its 3 gender=F rows (Shadley van Schalkwyk,
  Sami Rahmani, Kawalpreet Singh) are typos — treat as M.
- **Career-stat features shelved** ("ignore career build for now"): sheet innings-count
  columns are not career stats; D3.4 career fallback and D4 career compare mode on hold.
- **Dropbox fetch uses a per-FILE share link** for cricinfo_player_profiles (owner to
  create and add to secrets.md as DROPBOX_PROFILES_URL before D2). Folder links are
  not viable (dl=1 zips the entire multi-GB folder).

## 2026-07-07 — second round of decisions

5. **Ambiguous players proceed WITHOUT profiles for now.** D2 builds from automatic
   matches only; owner resolutions arrive later (a day or two) and are applied
   additively via `manual_matches.csv` — no rework, profiles appear on the next run.
6. **Table count: 16 is correct.** The database is the source of truth; the reference
   doc's "17 tables" header is outdated. D2 sanity check = all 16 tables present.
7. **"Recent" is ROLLING:** last three years counted back from the most recent
   match_date in the database — never a hardcoded date.
8. **Unknown position / unknown bowling style display:** deferred to design-stage
   decision (hide the section vs show "-"). Decide during D4/D5 design review.
9. **Player universe = selected in a team XI.** The 13 never-faced-never-bowled
   players COUNT (they were selected; stats may arrive as careers progress). Principle:
   presence in `match_players` (an XI) includes a player on the site, deliveries or not.
   D2 matching universe and unmatched-review counts to be recomputed accordingly.
10. **DROPBOX_PROFILES_URL saved in secrets.md and VERIFIED** (2026-07-07): with dl=1
    it downloads the profiles CSV byte-identical to source_data/ (MD5-checked). It is a
    folder+preview-form link rather than a /scl/fi/ per-file link — works today; D3
    fetch-failure alerting is the guard if Dropbox changes this behavior.

## 2026-07-07 — D2 gate decisions (taxonomy)

13. **Role/bowling taxonomy APPROVED:** role_group = Batter (incl. Wicketkeeper +
    Wicketkeeper batter), Allrounder, Bowler; Unknown → no group. role_subgroup =
    Wicketkeeper / Opening / Top-order / Middle-order / Batting allrounder /
    Bowling allrounder. bowling_group = Pace/Spin (unchanged). bowling_type =
    Off-spin / Leg-spin (Legbreak + googly) / Slow left-arm orthodox /
    Left-arm wrist-spin / Medium / Medium-fast / Fast-medium / Fast / Slow-medium.
14. **bowling_arm:** parsed from style text only, NEVER inferred from batting hand
    (owner: batting hand ≠ bowling hand). One approved cricket definition: Legbreak /
    Legbreak googly = Right arm by definition. "Right/Left-arm bowler" players show
    the arm with no pace/spin group.

15. **Bare "slow" = SPIN** (owner ruling 2026-07-07: "Slow probably refers to spin in
    this dataset"). The 10 "Right/Left-arm slow" players get bowling_group=Spin;
    their specific bowling_type stays blank (off/leg/SLA unknown from the sheet).

## Pending owner decisions (asked, not yet answered)

- (none currently — ambiguous_matches.csv resolutions in progress at owner's pace)

11. **Ingest-failure visibility: GREEN + ALERT EMAIL** (decided 2026-07-07). Runs stay
    green and the site keeps updating when individual files fail; the D3 Gmail alert
    module emails the owner specifically ("file X failed ingestion for N days").
    Until D3 exists, current green behavior stands.
12. **Old "Update Data" workflow in wt20-guide: DISABLED** — verified via GitHub API
    2026-07-07 (state=disabled_manually; Deploy to Pages and Feedback Digest left
    active as agreed).
- Manual resolutions of `ambiguous_matches.csv` (owner edits resolution column, then
  D2 encodes them into `review/manual_matches.csv` — permanent forever).
- ~~D0 gate handover clicks~~ DONE 2026-07-07: old workflow disabled (verified via
  API), DB_UPLOAD_ENABLED=true set, first full run green — cricket.duckdb on R2
  written by this repo at 08:27:05 UTC (run 28852362763). This repo now owns the DB.
  Awaiting owner's real-world spot-check to formally close the D0 gate.
