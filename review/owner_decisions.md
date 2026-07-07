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

## Pending owner decisions (asked, not yet answered)

- Confirm reference-doc "17 tables" → real schema is 16 (correct D2 sanity check to 16).
- Should a single failed ingest file turn the pipeline run red? (Current v1 behavior:
  logged only, run stays green, DB stays safe via per-file transactions.)
- Confirm 2023-01-01 as the "recent" coverage cutoff.
- The 13 non-striker-only (0-ball) player_ids: currently NOT counted as active.
- D4 filter display of position "Unknown" (61%) and "Right/Left-arm bowler"
  (pace/spin unknown, 49 rows).
- Manual resolutions of `ambiguous_matches.csv` (owner edits, then D2 encodes them
  into `review/manual_matches.csv` — permanent forever).
