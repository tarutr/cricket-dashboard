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

## 2026-07-07 — operations decisions

11. **Ingest-failure visibility: GREEN + ALERT EMAIL.** Runs stay green and the site
    keeps updating when individual files fail; the alert module emails the owner
    specifically ("file X failing since [date]", daily throttle, auto-prune).
    Implemented and live in D3 (pipeline/check_ingest.py).
12. **Old "Update Data" workflow in wt20-guide: DISABLED** — verified via GitHub API
    (state=disabled_manually; Deploy to Pages and Feedback Digest left active).
    D0 handover complete: DB_UPLOAD_ENABLED=true, first full run green, owner
    spot-check confirmed (Sciver-Brunt 75 off 47 vs SA, 2026-07-02). D0 gate CLOSED.

## 2026-07-07 — D3 acceptance gate PASSED

16. **D3 acceptance verified end-to-end** (all with owner watching): simulated
    upstream sheet edit propagated to the live site in one run; deliberate broken
    URL → site served last-good copy, DB + exports shipped, real alert email
    received by owner, run red only at the final tripwire; restoring the URL
    self-healed everything with no intervention. Note: the Dropbox folder belongs
    to the third-party data provider — the owner cannot edit the sheet, so
    staleness alerts mean "the provider stopped updating".

## 2026-07-07 — review workflow + gates

17. **D2 gate CLOSED** (owner: "sample profiles look fine for now"; exact design +
    additional metrics revisited later).
18. **Two-sheet review workflow APPROVED (owner's design):** the pipeline appends
    newly-unmatched players to `review/new_players_for_review.csv` (pipeline-owned,
    owner never edits); the owner fills resolutions and moves completed rows to
    `review/new_players_reviewed.csv` (owner-owned, pipeline never edits). No edit
    mismatch possible. Advisory emails continue. Repeatable instructions live in
    review/PLAYER_REVIEW.md. Resolutions in ambiguous_matches.csv and
    new_players_reviewed.csv are applied automatically on every rebuild.

## Open items (owner, at leisure)

- Manual resolutions of `ambiguous_matches.csv` (in progress, will take a while;
  applied automatically once pushed).

## 2026-07-07 — D4 build decisions

19. **D4 build list (owner picks):** matchup stats (batter × bowling-style, bowler ×
    batting-hand, men-only, always with "based on N of M balls"); the three free
    splits (batting-position, opposition, dismissal-type — UI only); bowler
    wicket-type breakdown columns; innings-progression splits. SPELL figures:
    later / maybe never.
20. **Venue + team normalization DEFERRED.** No venue splits; opposition splits ship
    for INTERNATIONAL cricket only (country names are clean); club-opposition waits
    for a future curated mapping project. Partnership stats deferred with it.
21. **Missing-data display (resolves deferred decision 8): SHOW INERT with "–".**
    Sections/filters with no mapped data (incl. all women's matchups) appear greyed
    with an honest "no style data" note — never hidden, never silently empty.

## 2026-07-08 — D4 data layer built (pending gate confirmations)

22. **D4 data layer complete** (matchup_batting, matchup_bowling parquets; +6
    wicket-type columns on bowling_innings; +6 progression columns on
    batting_innings). All new fields reconcile to raw deliveries via export gates
    AND were independently hand-verified at delivery level. Deployed to R2 as
    additive data (site JS not yet reading them — frontend is the next step).
23. **Dismissal attribution in matchups — CONFIRMED 2026-07-08:** a
    batter counts as "dismissed by pace/spin" ONLY for bowler-credited kinds
    (bowled, lbw, caught, c&b, stumped, hit wicket). Run-outs and other
    non-credited dismissals are NOT attributed to the bowler's style. Owner to
    confirm at the D4 comparison-review gate.
24. **Bare-slow bowlers in the fine matchup view — CONFIRMED 2026-07-08:** the 10
    owner-ruled bare-"slow"=Spin bowlers have no specific bowling_type, so in the
    fine-grained "vs Off-spin / Leg-spin / …" view they appear under a 'Spin'
    (unspecified type) bucket; in the coarse pace-vs-spin view they correctly
    count as Spin. Faithful to decision 15; owner to confirm the fine-view label.
    (Matchup views are Pieces 4–5 — still to be built, so this is not yet
    gate-confirmed against a live UI.)

## 2026-07-08 — D4 frontend build (Pieces 1–2)

25. **Piece 1 (profile filters) — GATE APPROVED** ("This all looks good"), reviewed
    on localhost. Owner design rulings realized in the build:
    - **Playing-role filter = BOTH levels:** a broad Batter / Allrounder / Bowler
      picker plus a cascading detailed sub-role (Opening / Top-order / Middle-order /
      Wicketkeeper for Batter; Batting/Bowling allrounder for Allrounder).
    - **Bowling filter = the 10 specific types** (Off-spin, Leg-spin, Slow left-arm
      orthodox, Left-arm wrist-spin, Slow-medium, Medium, Medium-fast, Fast-medium,
      Fast) — matches the decision-13 taxonomy. Not the coarse Pace/Spin.
    - **Women view:** the profile-filter row greys out with the exact note
      **"We don't have profile data on Women yet."** (profiles are men-only; 0% of
      women players have one). Switching gender clears any profile filter.
    - **Men is now the DEFAULT gender** (overrides SPEC §5.1 "Women"), so profile
      filters are live on first load.
    - **No automated search:** the Compare Stats results table is **blank on first
      load** and shows a **"Show results"** button; it reverts to that prompt on any
      filter change (so numbers are never shown for a scope the filters no longer
      describe). Table only — the Graph Builder still auto-updates. Owner: fine for
      now, "a million small design changes" get batched at the end.
26. **Piece 2 (new table metrics) — BUILT + VERIFIED, not yet gate-reviewed.**
    Bowler wicket-type breakdown = **counts** (six kinds; sum to `wickets`); a
    percentage/"dismissal fingerprint" split was NOT built — deferred to end-polish
    unless owner asks. Batting progression = first-10-ball / 11–20 / 21+ **faced-ball**
    strike rates, available in **all formats** (not phase-gated). Numbers cross-checked
    exact vs raw R2.
27. **CORS / preview:** R2 bucket CORS allows `localhost:8000` but not Vercel preview
    domains, so branch previews error. Owner declined to change R2 CORS / README now
    ("just show me the localhost"); reviews happen on localhost until owner chooses to
    widen CORS. Deferred, non-blocking.

## 2026-07-09 — D4 Piece 3 (free splits) owner design answers + build

28. **Piece 3 design answers (owner, 2026-07-09) — BUILT + VERIFIED, awaiting gate review:**
    - **Split style = BOTH.** Position and opposition ship as *filters* (every stat
      recomputes over the slice, composes across many players) AND a table-only
      **"Split by"** selector (one row per player × batting position / opposition /
      dismissal kind). The Graph Builder ignores Split-by and its honest scope line
      never claims it; the graph DOES honor the position/opposition filters.
    - **Position filter = individual positions 1–12** (12 = rare concussion-sub
      innings), multi-select chips, no grouping taxonomy baked in. Batting view only:
      greyed with "Batting view only" in bowling; selections kept inert.
    - **Dismissal breakdown = every kind separately, counts + % of dismissals.**
      24 new batting columns (12 kinds × count and % of dismissals) in a
      "Dismissals" section of the column picker. The 12 kinds are exactly the
      dismissal_kind values that carry dismissed = 1; retired hurt / retired not out
      are NOT dismissals and are excluded (in the dismissal split they read
      "not out"). Verified: the 12 kinds partition total dismissals exactly.
    - **Opposition = international only** (per decision 20): the filter, and the
      opposition split, grey out with "International cricket only for now" unless
      Team type = International.
    - **"Matches" honesty rule:** while a position/opposition filter or any split is
      active, the Matches column counts matches in which the player actually
      batted/bowled within the slice (the match-list data has no opponent or
      position columns, so this is the only honest count). Min innings applies
      within the slice too ("min 10 innings vs Australia").
    - **Verified exact vs raw R2** (browser = duckdb to the decimal): SA Yadav vs
      Australia (10 inns, 259 runs, 28.78 avg, 167.10 SR); Karanbir Singh at 1–2
      (51 inns, 2454 runs, 175.29 SR); SA Yadav dismissal columns (Ct 43 = 81.1%,
      Bwd 1, LBW 4, RO 1, St 3, C&B 1) and all position/dismissal split rows;
      Rashid Khan bowling × opposition split (the famous Rashid Khan is absent
      because Afghanistan does not exist in Cricsheet — SPEC §4.1, honest result);
      global 12-kind partition = 22,517 = SUM(dismissed) in the default scope.
    Branch `d4-piece3-free-splits`, stacked on Piece 2.
