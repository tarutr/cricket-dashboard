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

## 2026-07-09 — Site restructure (owner-directed, supersedes the one-page layout)

29. **Owner verdict on the current dashboard: too overloaded, unintuitive** — too
    many filters in too many places, too many column options, new features
    undiscoverable. Owner reviewed wireframes and chose a **FULL RESTRUCTURE**
    around three destinations:
    - **Leaderboard** (the compare table, slimmed): only Gender / Format / Date /
      Team type stay visible; Team, Min innings, the profile filters, position,
      opposition, and the advanced condition builder all collapse into ONE
      "All filters" drawer with a single "Apply and show results" button (the
      no-automated-search rule survives, decision 25). Applied filters render as
      removable pills. The 45 column checkboxes become one-click **presets**
      (Core / Boundaries / Dismissals / Phases / Progression + Customise).
    - **Player pages** (new destination): everything single-player moves here and
      just appears — position/opposition splits, dismissal fingerprint (counts +
      % in one visual), progression SRs, and the upcoming matchups. Reached by
      clicking any player name or via search. This **supersedes SPEC §2's "no
      player pages" non-goal and absorbs/expands the D5 pop-up plan.**
    - **Graph Builder**: unchanged.
    - **Sequencing: RESTRUCTURE FIRST** — matchups (old Pieces 4–5) are built
      once, directly into the player page, after the new structure lands.
    - **Leaderboard row-splitting: KEEP, TUCKED AWAY** — a small "Group rows"
      control in the table toolbar (off by default, out of the filter area);
      full splits live on player pages.
    New gates: **R1** leaderboard slim-down (scope strip + drawer + pills +
    presets + toolbar group-rows) → **R2** player pages → **R3** matchups on the
    player page (decisions 23/24 confirmed there) → final polish. All existing
    verified queries/metrics are re-homed, not rebuilt; numbers stay identical.

30. **R1 gate PASSED (2026-07-09):** owner reviewed the slimmed leaderboard on
    localhost — "this is largely good. There are design fixes, but we can do
    that later." Remaining visual tweaks are BATCHED into the final polish pass
    (consistent with decision 25's batching rule). R2 (player pages) proceeds.

31. **R2 (player pages) — BUILT + VERIFIED, awaiting gate review.** New Players
    destination: search-first; page shows a profile header (or the honest "No
    profile data for this player." — all women, unmatched men), an honest scope
    line (Format + Date + Team type only; the fixed caveat "leaderboard-only
    filters don't apply here"), then Batting (overview cards with the Test/MDM
    BPD swap, by-position table, vs-opposition table [international-only,
    greyed note elsewhere], "How out" fingerprint bars with counts + % of
    dismissals + not-out line, faced-balls progression cards) and Bowling
    (cards incl. BBI, wicket-type bars, vs-opposition). Blocks with no innings
    in scope show honest notes; player names in the leaderboard click through.
    Notable calls: (a) **player search matches EVERY name a player has appeared
    under and displays the most recent** — players.parquet keeps only the
    oldest registry name (e.g. NR Sciver), so the search reads name history
    from player_matches (covers decision-9 never-bat-never-bowl players too);
    (b) verbatim playing_role "Unknown" is suppressed in header lines.
    Verified exact vs raw R2: SA Yadav full page (incl. progression
    133.19/148.79/178.55 and his 1-innings 2-5 bowling card), JJ Bumrah
    bowling block (32 inns, 48 wkts, kinds 24/19/3/2 summing to 48, Pakistan &
    South Africa 9 wkts each), NR Sciver-Brunt (women: 30 inns, 954 runs,
    41.48, 137.07, HS 77). Branch `d4-r2-player-pages`.

32. **R2 gate ruling (owner, 2026-07-09): player profiles are POP-UPS, not a
    page.** "The player profiles look good… make the player profiles pop-ups,
    not a new page. Should be easy to close (an [x] or clicking outside) to go
    back to the original page." Implemented same-day: the Players tab is
    removed; clicking any player name in the leaderboard opens the profile as
    a centered overlay (full-screen on phones) over the current view, closing
    via ×, backdrop click, or Escape — the page behind is untouched. The
    in-popup "Find another player" search is kept. This realizes D5's original
    pop-up interaction model; other design changes remain batched for the
    final polish pass (decisions 25/30). Content/numbers unchanged from
    decision 31's verification.

33. **R2 pop-up gate PASSED + R3 scope addition (owner, 2026-07-09):** "Looks
    good." Matchup stats must be available in BOTH homes: the profile pop-up
    AND "searchable via the regular dashboard" — i.e. the original Piece-4
    leaderboard comparison mode returns alongside the pop-up sections. R3
    proceeds. Also confirmed: the owner's main model is Fable 5 High acting as
    orchestrator/planner/reviewer only; building is delegated to right-sized
    sub-agents; token efficiency is a standing requirement.

34. **R3 (matchups, both homes) — BUILT + VERIFIED, awaiting gate review.**
    (a) **Profile pop-up sections:** Batting gains "Vs pace and spin" (coarse) +
    "Vs bowling type" (fine, bare-slow bucket labelled "Spin (unspecified)" per
    decision 24); Bowling gains "Vs left- and right-handers". Every section
    leads with its coverage line ("Style data covers N of M balls faced (X%)")
    and renders an honest greyed note instead of tables when coverage is zero
    (all women, unmapped men — decision 21). (b) **Leaderboard matchup mode
    (decision 33):** a "Vs" selector in the table toolbar (batting: Pace/Spin +
    the fine types; bowling: right/left-handers). Active mode switches the
    table to the matchup views with fixed columns and a per-player Coverage
    column ("N of M (X%)"); position filters, stat conditions, row grouping,
    and column presets are inert with an explicit toolbar note; pills/badge
    update instantly; the scope sentence reads "vs Spin" (coarse) vs
    "vs Spin (unspecified)" (fine bucket) vs "vs left-handers"; the Vs select
    is disabled for Women with "No style data for women's cricket yet".
    Dismissals shown are bowler-credited only (decision 23, as baked into the
    data). **Data notes:** the dataset has NO bare-'Pace' bucket (only the 10
    bare-slow='Spin' bowlers, decision 15), so "Pace (unspecified)" never
    appears — correct, data-driven. **Verified exact vs raw R2:** SA Yadav vs
    Spin (59 inns, 322 balls, 454 runs, SR 140.99, avg 64.86, 7 out, coverage
    913 of 1,027 = 88.9%) in both homes; JJ Bumrah vs left-handers (25 inns,
    185 balls, 13 wkts, econ 6.75, coverage 649 of 707 = 91.8%) in both homes;
    his bowler-credited dismissal identity (52 = 53 minus the one run-out)
    reconfirms decision 23. Decisions 23 + 24 are due for owner confirmation
    at THIS gate against the live UI. Branch `d4-r3-matchups`.

35. **Decisions 23 + 24 CONFIRMED AT THE R3 GATE (owner, 2026-07-09):**
    dismissal attribution (bowler-credited kinds only) and the
    "Spin (unspecified)" bare-slow label are both approved against the live UI.
    Owner also flagged: the search box needing "Show results" reads as
    confusing — batched to the design/polish pass. Follow-up owner request:
    matchup mode gets a RESTRICTED column picker (choose among matchup-view
    metrics only; Coverage column always present), plus the free extra
    vs-style stats computable from existing matchup columns. Dismissal-KIND
    and PHASE breakdowns per style are acknowledged as possible but require a
    pipeline/data-layer extension (new columns in the matchup parquets) —
    offered to the owner as an optional future gated piece, not yet scheduled.

36. **Matchup data extension + restricted picker — BUILT, DEPLOYED, VERIFIED
    (2026-07-09, owner: "Add everything you can… build an alternate script to
    test first").** Pipeline: matchup_batting +18 columns (six dis_* dismissal
    kinds partitioning `dismissals`; T20 + ODI phase runs/balls per style),
    matchup_bowling +24 (six wkt_* kinds; T20 + ODI phase balls/runs/wickets
    per hand); odi_* NULL for Hundred matches like the main views. Process as
    mandated: pipeline/dev_test_matchup_extension.py verified everything
    read-only against the local DB copy BEFORE export_parquet.py was patched
    (zero mismatches on all 1.49M rows; delivery-level two-way checks equal;
    old columns byte-identical), then six permanent reconciliation gates were
    added to run_gates. The export change was cherry-picked to main (additive
    data, decision-22 precedent — live site unaffected) and a green pipeline
    run published the extended parquets to R2. Frontend: matchup mode's fixed
    columns replaced by a RESTRICTED PICKER (matchup-only vocabulary, Basic/
    Dismissals/Phase sections, phase gated by format, Coverage always fixed)
    plus free stats (4s/6s/BPB/BPD vs style; boundary counts + wickets-per-
    innings vs hand). Verified exact vs R2 in-browser: SA Yadav vs Spin —
    caught 4 + stumped 3 = 7 dismissals, death SR 200.00, PP SR 143.64;
    JJ Bumrah vs right-handers — caught 13, bowled 13, PP econ 6.18, PP
    wkts 8. Branch `d4-r3-matchups` (frontend) + main (pipeline).

37. **Matchup positions + stat conditions — BUILT, DEPLOYED, VERIFIED
    (2026-07-09, owner: "same problem with bowlers — why aren't we allowed to
    do matchups by positions and stat-conditions?").** Pipeline (test-first
    again, 39/39 harness checks, then main + green run): matchup_batting
    gains `batting_position` (the batter's own, verbatim sql_batting
    definition); matchup_bowling REGRAINED to (match, innings, bowler,
    batting_hand, striker's batting_position) — 1.35M rows — with rollup to
    the old grain reproducing every row/column exactly and permanent gates
    added. Frontend: the position filter now applies in matchup mode — on the
    bowling side it filters the position of the batters faced ("Bumrah vs
    openers"), with the scope token/pill reading "to batters at 1, 2" and a
    drawer hint; bowling-matchup innings counts are DISTINCT innings (not
    position buckets). Stat conditions are namespace-aware: authored in the
    active mode's vocabulary, applied by key-overlap, with honest
    "N of M stat conditions apply here" notes in both modes and cross-mode
    condition survival. A stale-sync wiring bug (drawer controls not
    refreshing on Vs changes) was caught in verification and fixed
    (drawer.sync on every store change). Verified exact vs raw R2: Bumrah vs
    right-handers at 1–2 = 27 distinct innings, 177 balls, 9 wickets;
    Karanbir Singh vs Spin at 1–2 = 33 inns, 488 runs @ 190.63, out 11;
    "caught vs spin ≥ 2, min 10 innings" = 576 players. Branch
    `d4-r3-matchups` + main (pipeline).

38. **R3 GATE PASSED + PUBLIC DEPLOY (owner, 2026-07-09):** "All looks good."
    The full D4 scope — restructure (R1 leaderboard, R2 profile pop-ups),
    matchups everywhere (style/hand/position/conditions, coverage-honest),
    splits, dismissal breakdowns, progression, profile filters — is
    owner-approved. Owner chose to DEPLOY NOW: the branch chain merges to main
    and ships to the public Vercel site (cricdb.vercel.app), with the batched
    design/polish pass to follow on top. NEXT PHASE = polish: owner's design
    list + feedback form (Supabase, RLS) + performance audit + README, then
    optional deferred items (team/venue pop-ups, headshots, preview-domain
    CORS, name normalization).

## 2026-07-10 — Pre-polish code review: fixes approved + MERGED

39. **NUMBER CORRECTION (found by the full-repo code review, owner-approved,
    merged):** coarse matchup batting **innings** were double-counted. The
    metric used COUNT(*) over rows whose grain is per bowling *type*, so an
    innings facing e.g. both off-spin and leg-spin counted twice when grouped
    to Pace/Spin. SA Yadav vs Spin 59→**38**, vs Pace 99→**56** (career total
    60 makes 99 impossible). Decision 34's recorded "59 inns" had been
    verified against a check query sharing the same counting flaw — the site
    and the check agreed while both were wrong. Fixed to
    COUNT(DISTINCT match:innings) (the decision-37 pattern already used on
    the bowling side); the fine per-type view and all other stats
    (runs/balls/SR/avg/coverage) are unchanged, re-verified exact vs raw R2
    in both homes (leaderboard Vs mode + profile pop-up). **Standing
    verification rule going forward: anchor checks must derive counts
    independently (COUNT DISTINCT from raw), never by reusing the app's own
    aggregation shape.** Also noted: decision 37's spot-check "caught vs
    spin ≥ 2, min 10 innings = 576 players" reads 478 on today's data — the
    rolling 3-year window moved; old and new code agree at 478 (data drift,
    not regression).

40. **Code-review fix batches — BUILT, VERIFIED, owner-reviewed on localhost,
    MERGED TO MAIN (2026-07-10).** Frontend (`review-fixes`): one shared
    HTML-escaping module (XSS hardening; team/player names were unescaped in
    several spots); transient failures no longer permanently disable the Vs
    type list / PNG export / drawer options (they retry); stat-condition
    edits are honest on drawer close (Escape/backdrop without Apply reverts
    the table to the prompt; the graph updates once per committed change) and
    typing keeps focus; the column picker survives ticking any number of
    boxes (owner's known complaint — popover re-hosted outside the table);
    donut charts restricted to genuinely additive metrics via an explicit
    `additive` flag (High Score removed); the Graph Builder roster reseeds on
    position/opposition/profile changes and ranks correctly in matchup mode
    regardless of picked columns; matchup mode now runs ONE query instead of
    two full scans (result sets verified byte-identical vs raw R2 across 4
    scopes); player pop-up 14→11 queries (text byte-identical); graph seeding
    is a bounded top-N query (cap ties now break deterministically by id —
    previously arbitrary); fewer boot queries; Chart.js deferred. Pipeline
    (`pipeline-safety`): 21 new ADDITIVE validation gates (matchup↔innings
    rollup cross-checks, batting_position cross-check, T20/ODI phase sums on
    the foundational files, dots/fours/sixes/maidens/wides/noballs
    reconciliation vs deliveries, vocabulary tripwires), all green against
    the real DB; R2 upload retries with manifest-last and loud hard failure;
    both-gender tripwire (any NEW both-gender player_id is auto-held from
    matching + emailed, protecting decision 2 forever); unmatched-player
    alert-throttle fix; requirements pinned (+botocore, −numpy); pipeline
    failure now emails the owner; pip cached in CI.

41. **B6 APPROVED (the frozen legacy scripts):** owner signed off on three
    defensive fixes to the ported wt20-guide scripts — (a) ingest.py: a
    squad name missing from its own file's Cricsheet registry must not drop
    the whole match (load the match, skip the link, plain-English alert);
    (b) a timeout on the Cricsheet download, routed through the alert
    emails; (c) integrity checks in download_db/upload_db before trusting a
    downloaded DB or overwriting the R2 copy. Built as a gated batch on top
    of this merge. Ingestion *logic* (incremental, per-file transactions)
    remains untouched.

42. **POLISH-PHASE DESIGN REVIEW APPROVED (2026-07-10):** the full browser-driven
    review (desktop + 375px) plus static CSS audit stands as the work list —
    fix batches A–F kept "on board as changes to make". Owner then ruled on the
    fundamental questions: **Leaderboard tab renamed "Stats", Graph Builder
    renamed "Graphs"**; discipline (Batting/Bowling) moves into the scope strip
    with the view switcher alone in the header; **"Customise…" renamed
    "Columns"** in every mode and it must not move or vanish when matchup mode
    reshuffles the toolbar; **Dismissal grouping is CUT** from Group rows (this
    also removes the silent no-op on the Bowling view; grouping options become
    discipline-aware); **batting position becomes a plain multi-select dropdown**
    in the drawer — owner explicitly rejected the hero 1–12 circles and the
    proposed band shortcut chips; **one hero "Team" filter** — "Against
    (opposition)" and "Has ever played for (career)" are renamed exactly so and
    demoted to the advanced area with Stat conditions; dismissal columns in the
    picker prune to the six real kinds + one "show as %" toggle + rare types
    collapsed; search becomes player-first omnisearch (type a name → open the
    popup regardless of leaderboard filters, with a "show in table" secondary
    action); empty results must state their reason. Interaction-model fixes
    approved: toolbar stays mounted during re-query; stat-condition validation
    (no silent drop), pills named for their condition ("Runs ≥ 300"), subtitle
    honestly includes stat conditions; single Apply in the drawer.

43. **GRAPHS OVERHAUL APPROVED (2026-07-10):** graph catalog approved as
    specced — Bar top-N (fixed: leader on top, all labels, no clipping, Bars⇄Dots
    lollipop toggle, 2–15 players), Donut share-of-total (2–10), Scatter
    two-metric map (+median quadrant guides, 5–60), **Radar kept but overlays
    removed → small multiples** (one mini-radar per player, shared scale, 1–6),
    NEW grouped phase bars (one rate family, 2–8), NEW dumbbell two-scope
    compare (e.g. SR vs pace ↔ vs spin, 2–12), NEW slope/arrow then-vs-now with
    **explicit date pickers for both windows (owner ruling — not an automatic
    range split)**, NEW line chart progression by year from the innings parquets
    (number-producing SQL → data-engineer + independent anchor verification;
    year granularity v1; sub-threshold points greyed). Metric-type taxonomy:
    add `kind: total|rate|percent|peak` metadata to metrics.js (no SQL change;
    anchors re-run regardless). "Turn into graph" bridge from Stats tab
    (honest titles generated from actual seed state — also the fix for the
    title-honesty bug), "Graph this player" in the popup, caps restore dropped
    players when switching back, visible ✎ on editable title/subtitle,
    copy-PNG-to-clipboard. **Footer "debug console" link removed from
    production (owner ruling).** Build order: B1 mechanical UI → B2 interaction
    model (wireframes gate BEFORE build) → B3 graph fixes+bridge → B4 new
    charts → B5 CSS consolidation → B6 hygiene. Each batch reviewed on
    localhost:8000; batches touching query plumbing re-verify the standing
    anchors independently (decision 39 rule).
