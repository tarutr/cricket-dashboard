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

44. **DESIGN ROUND 2 APPROVED (2026-07-10):** after reviewing the built batches on
    localhost, the owner approved the full second-round evaluation. Rulings:
    (a) **Player popup redesign**: identity header uses the real headshots
    already in player_profiles.parquet (1,360 flagged has_real_headshot; all
    others get a designed monogram medallion — never a broken image; no-profile
    players and all women keep medallion + honest note); popup becomes a
    single-scroll layout with a **Batting | Bowling toggle** under the header,
    each discipline a tight grid; the popup gains its **own filters drawer
    that RE-SCOPES the whole popup** (vs type, dates, positions, opposition —
    every section recomputes; pill row + honest scope line + reset).
    (b) **Scope strip**: Format and Team type become **multi-select checkbox
    dropdowns** (v1-style: summary label, checkbox rows, apply-live);
    **"Club" renamed "Domestic" everywhere** (display only, data values
    unchanged); "Both" options deleted (tick both boxes); Batting/Bowling
    moves into the scope strip; header keeps only Stats/Graphs.
    (c) **Min innings removed as a base filter** — it becomes an ordinary
    advanced stat condition; search surfaces anyone with ≥1 innings;
    sub-sample rate values render MUTED with a sample tooltip (via each
    metric's minSampleComponent, same honesty language as By-year's faded
    points); v1-style toast when a searched player is hidden by an advanced
    condition. Anchors re-derived without the gate (decision 39 rule).
    (d) **Graphs**: adopt v1's selection model — candidates pool (never
    truncated) + checked subset in a "N of M selected" checkbox dropdown,
    over-cap rows disabled with an explanatory tooltip, Manual/Best/Worst
    auto-pick when pool > cap; adopt v1's recommend() engine (types grey out
    with reasons + a Recommended tag); donut becomes top-7 + "Other";
    "Back to your table" must PRESERVE the table (view switches re-render the
    cached result; no-auto-search applies to filter changes only);
    "Turn into graph" renamed **"Graph"**, grouped with "Columns" flush right.
    (e) **NEW Benchmark chart** (owner's image_inspiration/graph_example.png):
    one anchor player = 100% line; one row per metric grouped by kind; bar =
    best other player as % of anchor with name; red where the anchor is
    beaten; right columns = anchor's raw value + rank; pool = current filters
    with per-metric min-sample floors stated in the footer.
    (f) **Percent metrics approved for By-year**; dumbbell title copy stays;
    MIN_BALLS_PER_YEAR stays 30 pending owner's reaction to the explanation.
    Build order: B2R interaction model → B7 popup redesign → B8 graphs II;
    owner reviews each on localhost:8000 (explicit go-ahead supersedes a
    second wireframe round). Anchor re-verification wherever query code moves.

45. **MIN_BALLS_PER_YEAR = 30 CONFIRMED (2026-07-10):** owner ruled 30 balls is
    the right per-year sample floor for the By-year chart after having the
    mechanism explained (points from thinner years draw faded, never hidden,
    with the footnote stating the floor). No change needed — 30 was already
    the shipped default in src/graph/timeseries.js.

46. **DESIGN ROUND 2 VERDICTS + FIX-ROUND RULINGS (2026-07-11):** the owner
    reviewed all 63 checklist items (full item-by-item record:
    review/design_round_2_decisions.md — sections A/D/K passed unchanged) and
    ruled on the open items. Standing rulings from the follow-up Q&A:
    (a) **Search split** — the header gains a global player search that opens
    the popup; the search above the table ADDS the picked player to the
    current results (removable "+ Player" pill), even if filters would
    exclude him. (b) **"R. Pos."** — wherever the dashboard shows a player's
    most-common batting position, label it "R. Pos." with a hover description
    ("Regular position — where this player most often bats"); innings-slicing
    position filters keep their behaviour, labelled clearly. The filter
    drawer's profile section gains R. Pos. (a player-level most-common-
    position filter); the drawer reorganizes to Team / role / batting hand /
    R. Pos. / bowling style, with Against-opposition folded into Advanced.
    (c) **Team filter** — one Team section with a dual dropdown: mode
    "Current team | Historic team" + the team picker; the separate "Has ever
    played for" filter goes away. (d) **Mobile graphs** — charts get fixed
    canonical export sizes; on phones you pan sideways INSIDE the chart box
    (page never scrolls sideways); screen == export. (e) **Average
    thin-sample floor raised 3 → 5 dismissals** (averages only; other
    dismissals-based metrics stay at 3). (f) **Graphs lose all defaults** —
    nothing auto-fills; empty-with-guidance when no stats search was run;
    results as pool when one was; greyed types stay clickable and explain how
    to become usable; user choices persist; "By year" renamed "Line";
    picker captions removed; "Graph this player" gets a chooser popup.
    (g) **L3 v1 extras** (glossary tooltips, per-chart info, CSV export,
    click-to-highlight, Randomise): ALL wanted — deferred to the round after
    this fix round.

47. **DESIGN ROUND 4 RULINGS (2026-07-17):** (a) **Vs/matchup mode must adhere to ALL
    applied filters** — the Vs dropdown is an internal search among the players the
    filters chose; nothing silently drops. The two current violations (R. Pos. and
    added players/pins are dropped on entering Vs mode) are to be fixed. R. Pos.
    carries with its PLAIN meaning ("usual top order players, full v pace" — owner's
    words): restrict the roster by usual position, show the full vs-bucket record.
    The Vs-only striker-position filter (state.positions) is untouched. (b) **Numeric
    stat conditions re-score against the bucket** ("SR vs pace ≥ 140") — owner
    confirmed today's behaviour is correct ("obviously"); no change. (c) **Four new
    Vs stats approved**: Matches, Runs per Innings, High Score, Best Bowling — all
    app-side query work only (no pipeline/DB change; HS method proven live: SA Yadav
    HS vs Spin = 47, method reproduced the 38-inns/454-runs anchor). (d) **X-ball SR
    (first 10 / 11–20 / 21+) is conceptually meaningless against a bowling style** —
    permanently out, not parked. (e) **A9 approved**: Team/Opposition/Event/Venue
    option lists scope to the FULL search conditions (gender+format+date+team-type).
    (f) **Pin pills recolour steel-blue** (red freed for the delete state).
    (g) **Instant/pending, final**: sort, columns picker, drag-reorder are instant;
    PICKING a player from the results search drops their row in instantly (no Search
    press); a pill's ×/+ (filter AND pin) stays PENDING — soft-delete stages with a
    red-outline undo and commits on Search. Recorded for honesty: the orchestrator
    initially over-extended the instant ruling to pin ×/+ "for symmetry"; the owner
    corrected it; reverted same day (commit b556f92).

48. **GOVERNANCE PACKAGE (2026-07-17):** after the over-reach in 47(g) the owner
    ordered an instruction-surface audit and approved: (a) a one-page **CLAUDE.md**
    as the supreme, always-loaded contract (numbers-sacred + anchors; decisions-are-
    law/defects-are-fair-game; verification ritual; pointers not copies).
    (b) **.orchestrator/ORCHESTRATION.md** — the /opus-orchestrator skill's rules
    distilled into the repo (routing table, escalation ladder, brief/report formats,
    resume protocol, model-resume gotcha) so the discipline holds in any session.
    (c) `.orchestrator/plan.md` replaced with a signpost stub (the skill's entry
    path lands on live state, not the finished D0–D4 plan — archived at
    review/archive/orchestrator-plan-d0-d4.md). (d) Completed-round review docs
    moved to review/archive/. (e) THIS FILE is the only decision log; design-plan.md
    is a status tracker and must not re-narrate decisions. (f) Subagent latitude
    ruling: agents may fix real defects they trip over (report under "Also fixed")
    but must never reverse/extend an owner-ruled behaviour; orchestrator briefs must
    trace every behavioural item to an owner sentence.

## 2026-07-19 — Round 5 review batch (23 items) — full detail in review/DESIGN_ROUND5_HANDOFF.md

49. **NO DATA-POLICING (standing rule, reverses 44c/45/46e/44e).** Strip ALL sample-floor fading/
    muting/greying/thin-sample controls; plot everything however thin the sample; keep only
    NULLIF divide-by-zero guards. Owner: "user's prerogative — provide optionality, don't control
    for the user; don't assume the user needs parental controls." Verified in code: most floors were
    ALREADY removed in an earlier pass; only MIN_BALLS_PER_YEAR remained (dies with the Line redesign)
    and `minSampleComponent` is now dead metadata to delete.

50. **Round-5 fixes (owner-approved, unbuilt — see handoff for exact resolutions):**
    #1 remove ALL toolbar note text (dates always match popup — verified). #2/#3/#11 PIN SYSTEM: a pin
    checkbox column left of #, pinned players float to top, resets on filters-popup change, persists
    through toolbar-only change, no-data pin shows in-scope data or "–"; searching an existing player
    lifts them to top. #4 toolbar-only changes must NOT reorder the table. #5 Matchup(Vs) = first entry
    INSIDE Advanced metrics (above Dot Ball %), not a standalone subheader. #6 a filtered metric
    auto-adds its column. #7 conditions become PER-DISCIPLINE (like columns) — numeric conditions don't
    leak batting↔bowling; **identity filters (role/hand/bowling-style/teams) PERSIST** across the toggle
    (player-level), everything numeric is per-discipline (#15 ruling). #8 separate the striker Batting-
    position from R.Pos (stop it auto-appearing with Vs). #9 filters popup FULLY STAGED — pills + table
    render from APPLIED state only, nothing until Search (reverses Wave 4a "pills reflect pending").
    #10 grey Keep-Columns on discipline-switch/blank. #13 graph reset link → "Reset to full player set",
    grey when full, boxed with the x-of-x dropdown. #16 tidy the player-popup drawer to main-drawer
    density. #18 personal-data coverage note right-aligned in the pills row; REMOVE the "Matchup mode"
    note row. #19 red-outline EVERY empty required graph control + naming message (today only slope/
    dumbbell windows get it). #22 remove Best Bowling from graph pickers (table column + two-box filter
    stay; reverses Round-4 graphable ruling). #23 route the graph chart-metric labels through
    metricDisplayLabel so they can't diverge from the shared drawer (the drawer is already one shared
    component in both surfaces). #12/#17 NO code change (handedness filter verified correct; bowling-
    style-as-batting-filter is intentional/documented). Scatter: X/Y dropdowns exclude each other's pick.

51. **#20 "Runs per Innings" — REMOVED ENTIRELY** from the UI (owner never authorised it; ≠ batting
    average). **#14 club/domestic opposition ENABLED now** on raw team names (consistent with the Team
    filter, which already runs on the same un-normalized names) — **team-name normalization (Team +
    Opposition) is the FIRST POST-ROUND to-do**, not this round (reverses decision 20's international-only
    gate). **#21 LINE GRAPH REDEFINED:** Y-metric × X-dimension × up to 6–8 lines (exact cap on sight),
    NO floors; X-dimensions = Innings (index) / Date(month) / Date(year) / Date(event) / Phase / Batting
    position / Vs bowling type / Opposition / Venue / Innings-of-match / Match result — ALL built together
    ("why can't we have it all"); PLUS **per-over** via a test-first pipeline data extension (owner: "let's
    do per over" — browser loads aggregates, so per-over needs new parquet columns). Replaces the old
    year-only line entirely. Build order R5-A…R5-F in the handoff. Branch polish-b1-mechanical; merge = separate decision.

52. **Sort arrow = active-sort indicator ONLY (owner ruling at the R5-A gate, 2026-07-19).** After R5-A's
    #4 (a toolbar-only change preserves row order instead of re-sorting), the column header still showed its
    ▲/▼ arrow even though that column was no longer ordering the table. Owner: "The arrow should not exist on
    a column that it isn't sorting. The logic is backwards. Once the column sorts, the arrow shows up —
    therefore there can be no arrow on a column that isn't sorted." → The sort arrow (and the sorted-column
    styling) appears ONLY when the current row order is the direct result of an active sort on that column
    (a fresh/popup Search that ranks, or a column-header click). After an order-preserving toolbar commit, NO
    column shows an arrow. Folded into Wave R5-B (same files). Display-only; anchors unaffected.

53. **R5-D Line design APPROVED at the pre-build gate (2026-07-21); line cap = 6.** Owner confirmed the
    two-dropdown model (X axis + Metric), all 11 X-dimensions built together (Innings index / Date-month /
    Date-year / Date-event / Phase / Batting position / Vs bowling type / Opposition / Venue / Innings-of-
    match / Match result), per-bucket Y via the existing metric sqlExpression grouped per (player, X-bucket),
    no floors, gaps for missing buckets. **Max 6 player lines** (changeable once seen live). Per-over remains
    R5-E (needs the pipeline extension; owner will give a separate explicit go). **#18 coverage note: PARKED**
    — owner will decide at the final hands-on review whether to build a brand-new note (none exists today;
    the old "Matchup mode" note was already removed in R5-A). **#19** fresh-load chart-type red outline left
    as-built (per spec); owner may revisit at final review.

## 2026-07-22 — Round 6 review batch (owner localhost review of Round 5) — 12 items
Owner reviewed R5 on localhost + gave 12 notes (full triage in the orchestrator's turn). Priority ORDER
confirmed by owner: (1) root-cause #5/#10 graph discipline/filter mixing, (2) bugs #1/#3/#6, (3) UX/
chartability #9, (4) features #7/#8/#11/#12. DEPLOY HELD until the bugs are clean.

54. **Batting-hand persistence REMOVED (owner 2026-07-22, reverses decision 50's "identity filters persist").**
    "batting hand" must NOT appear as a filter in the BOWLING discipline, and must NOT persist across the
    batting↔bowling toggle — owner: a player's batting hand and bowling arm differ, so persisting it into
    bowling "is more confusing than useful." (Other identity filters — role, teams — not mentioned; scope this
    change to batting hand only unless owner extends. Bowling style stays a batting filter per decision — the
    intentional "how leg-spinners bat" #17, untouched.) Round-6 item #2.

55. **Graph Filters popup FULLY STAGED behind "Apply to graph" (owner 2026-07-22, Round-6 #5/#10 fix).**
    Root cause (read-only investigation): the graph mounts the SAME shared filter components as Stats but wires
    them with no-op callbacks + no store-subscribe, so popup edits don't re-render (graph.js:2113-2124 vs
    main.js:288-296/604-660/783-797); AND the discipline/gender/Vs selects write to the SHARED store instantly
    (filters.js:740-744), ahead of the graph's Apply gate — so the chart's namespace changes before the roster/
    metric reseed (→ batting metric fetched against bowling data, #10; toggle looks dead, #5). "Average (vs
    style)" (#4) is NOT a plain leak — it correctly shows only in Vs; the same no-refresh let it linger.
    RULING: (Part 1) wire the graph popup to live-refresh like Stats; (Part 2, owner chose option b) make the
    WHOLE graph Filters popup staged — discipline/gender/Vs/format edits do NOT touch the shared store (and so
    never silently change the Stats scope) until "Apply to graph" commits them atomically + reseeds. graph.js-
    focused; query builders byte-identical (display/state only). #6 (reset wrong set) likely same family — check
    under this fix. Keeps the Apply-to-graph gate; removes the surprising Graphs→Stats scope side effect.

56. **Round-6 #1 (fine-Vs re-sort) — CLOSED, not a code bug (owner accepted 2026-07-22).** The preserve-vs-
    resort decision is `load(null,{resort:!fromToolbar})` (main.js:775) — it keys ONLY on toolbar-vs-popup
    Search, NEVER on the Vs dimension (the only group/type branch is the SQL bucket column, table.js:301). So
    a toolbar fine-Vs cannot re-sort differently from coarse. Verified across 4 fresh-loaded scenarios (all
    preserve, arrow clears). The re-sort the owner saw was a stale hard-cached older module in the browser
    (ES-module caching gotcha) — owner: "if the code literally can't have it be different, it can't be." No fix.

57. **Round-6 #4 (the "Average (vs style)" metric) — RENAMED, not removed (owner 2026-07-22).** "Average (vs
    style)" / "Average (vs hand)" are NOT a separate/redundant filter — they are the SAME `key:"average"` metric
    in the matchup namespace (metrics.js:924/1315), i.e. the ordinary Average shown WHEN a Vs bucket is active
    (auto-scoped). A separate internal def exists only because Vs data lives in a different pre-bucketed table
    needing its own sqlExpression. Removing it would strip the average from Vs mode. Owner's intent ("I just
    pick Vs + Average, I don't need a specific vs-average") is already how it works; the only defect was the
    confusing label → RENAMED to plain "Batting Average"/"Bowling Average" (label-only; sqlExpression/key/kind
    byte-identical; anchors unaffected). The Vs context is conveyed by the Vs pill/scope line.

58. **Round-6 #8 (plain-bowling X=Phase asymmetry) — RESOLVED by adding the Middle bucket (owner 2026-07-22,
    "Add middle bucket to #8"; option (a) of the checklist).** On the plain BOWLING Line X=Phase view, Economy
    and Wickets previously drew only Powerplay + Death because the middle-overs metric variants were never
    catalogued in the plain bowling namespace (only in matchup_bowling). Added 4 metric defs to the plain
    bowling namespace in metrics.js: `mid_economy` ("Middle Overs Economy", `SUM(mid_runs_conceded)*6.0/
    NULLIF(SUM(mid_balls),0)`, isPhaseMetric t20), `mid_wickets` ("Middle Overs Wickets", `SUM(mid_wickets)`,
    additive), plus the ODI pair `odi_mid_economy`/`odi_mid_wickets`. These MIRROR the existing pp_/death_
    siblings exactly (same isPhaseMetric/discipline/kind), so `phaseMembersFor` (timeseries.js — PHASE_MEMBERS
    already listed them) now returns the full Powerplay→Middle→Death trio. Pure ADDITIVE catalogue change: diff
    is 46 insertions / 0 deletions, no query builder touched; verified byte-identical builders, all 12 phase
    members eligible (T20+ODI), Middle a real figure (independent DuckDB: a bowler's mid econ 5.64 over 133
    balls), and the 2,813 baseline + Karanbir 2,454 reproduce on screen. Side effect (intended, consistent):
    "Middle Overs Economy"/"Middle Overs Wickets" now also appear in the normal bowling column/condition
    pickers alongside the existing Powerplay/Death entries — completing the trio, matching "show all data".

59. **Round-6b four display refinements (owner 2026-07-22; all DISPLAY-ONLY, no query/formula touched).**
    (1) **Player popup "Vs opposition" table** (playerSections.js) — the collapsed cap snapped to the left
    column's exact pixel height, slicing the last row mid-height. Now snaps to the bottom edge of the row the
    boundary crosses, so the last visible row is always whole; a little TALLER than the left column is fine
    (owner ruling). Verified on Kohli: cut lands cleanly between rows 19/20, no slice.
    (2) **Graph roster rows** (graph.js) — removed the `#1/#2…` seed-rank chip that was cluttering each row.
    (3) **Graph roster usability badge** (graph.js + styles.css) — renamed "CHARTABLE"/"NOT CHARTABLE" to a
    single compact **`[usable]`**: green for usable; red for not-usable with a line-through on the WORD only
    (the brackets stay intact — owner's exact spec). Smaller font, no uppercase, so it stops eating the
    player-name column. Same underlying chartability probe (#9) — label/format only.
    (4) **Graph left card order** (graph.js) — the Players group moved to directly below Chart type, reordered
    inside to mode-toggle → dropdown → search. Because the roster panel is absolutely positioned, opening it
    from a high position now keeps it within the viewport instead of extending the document downward and
    forcing a whole-page scroll (owner's complaint). The panel keeps its own internal scroll + filter as before.
    Verified: builders byte-identical, roster pool still 2,813, both badge states render per spec, dropdown
    opens with zero page scroll (document height unchanged at viewport height).

60. **Round-6c graph dropdown containment + selection pinning (owner 2026-07-22; DISPLAY-ONLY).** Follow-up to
    decision 59 #4: reverting that reorder and fixing the underlying problem instead.
    (a) **Left-card order reverted** to Chart type → Metric → Players (mode toggle → search → roster dropdown)
    — the owner's original preference.
    (b) **Dropdowns can no longer fall below the window.** The graph's metric / X-axis / chart-type / phase /
    anchor `searchSelect`s now mount with `portal: true`, and the roster dropdown's `wireDropdown` was upgraded
    to portal its open panel to `<body>` (position:fixed) too. `searchSelect.positionPanel` (both single- and
    multi-select copies) and the new graph `positionFixedPanel` choose direction BY FIT: measure the panel's
    natural height, open below when it fits below, else flip ABOVE when it fits above, else use the roomier side
    (height clamped to the chosen side with internal scroll). This matters because the roster dropdown sits at
    the BOTTOM of the toolbox: a first attempt used an "open down if ≥160px below" threshold, which still
    dropped it downward and let it hang below the toolbar (owner: "still flipping down and going below the
    toolbar"). With the fit rule the ~310px roster panel no longer fits in the ~200px below the bottom-of-card
    toggle, so it opens UPWARD into the card. Verified on localhost at 800px: roster toggle top 466/bottom 506,
    panel opens upward to top 138/bottom 460 (fully within viewport, above the toggle), zero page scroll;
    metric/chart-type near the top still open downward.
    (c) **Selected players pinned to the top** of the roster dropdown (checked first, stable by pool order) so
    the current selection is never scattered through the list — verified all 15 auto-selected sit at rows 0–14.
    Query builders byte-identical; roster pool still 2,813.

61. **Round-6d five small fixes (owner 2026-07-23; all DISPLAY-ONLY, no query/formula touched).**
    (1) **Player pin PILL removed** (pills.js) — the pin CHIP above the table is gone; the pin COLUMN is the
    single place to see/manage pins (click to pin/unpin, pinned rows float to top; a searched-in player IS a
    pin, so they float in automatically — confirmed). Pin FUNCTIONALITY untouched (state.pinnedPlayers, float,
    and the "(no innings)" TOAST in main.js all remain); only the chip and its per-pin "(no innings)" label go.
    (2) **Player-popup "Vs" picker regrouped** (searchSelect.js + styles.css + playerFilters.js) — added opt-in
    group-header support to the shared searchSelect (options carrying a `group` render a quiet section divider;
    flat/unchanged when absent, so every other picker is unaffected), then grouped the Vs options under **Pace**
    (All pace + fast types) and **Spin** (All spin + spin types), restoring the clustering the old <optgroup>
    gave. Coarse catch-alls relabelled "All pace"/"All spin"; values unchanged → results identical.
    (3) **Popup opposition table** (playerSections.js) — when the two-col layout is STACKED (narrow/mobile), cap
    the opposition table to **5 rows** with Show more/less; when SIDE-BY-SIDE, keep the R6b height-match. A
    self-removing window-resize listener recomputes on width change (fixes the "doesn't re-fit on resize" flag).
    Verified: desktop 20/24 rows height-matched; 500px → exactly 5 rows.
    (4) **Auto-add filtered columns** — NO CHANGE NEEDED: main.js autoAddFilteredColumns already adds ALL
    filtered metric columns and sorts by the first (owner's requested behaviour was already the code's behaviour;
    the old flag was only "ranks by first", which is what the owner wants).
    (5) **Export while dirty** (graph.js) — Export PNG / Copy PNG now disable whenever the chart is dirty
    (pending control edits not yet drawn) and re-enable after "Update chart", so you can't export a chart that
    no longer matches the controls. Verified: draw→enabled, change metric→disabled, Update→enabled.
    All verified on localhost, 0 console errors, 2,813 baseline reproduced; query builders byte-identical.

62. **SPEC §4.1 calc-law brought up to date + `retired out` ruling + Donut popup-only + new backlog item
    (owner 2026-07-23).** During the docs sync the SPEC agent flagged that §4.1 (preserved verbatim) was
    incomplete vs the code. Owner authorized updating it (a DOC edit describing existing behaviour — no number
    moves; each addition verified against `export_parquet.py`):
    - **`retired out` IS a dismissal** (for batting average). Confirmed by the owner AND matches the code
      (`NON_DISMISSAL_KINDS = ("retired hurt","retired not out")` only). Removed the old "ask owner to confirm"
      note.
    - Added **ODI/50-over phase ranges** to §4.1 (over_number 0–9 / 10–39 / 40–49 = overs 1–10 / 11–40 /
      41–50), as a SEPARATE `odi_` column family from T20 (0–5 / 6–14 / 15–19); corrected the old "stored using
      the same over ranges, T20-only surfacing" claim (the code stores distinct odi_ columns and the UI
      surfaces the ODI family for a single 50-over bucket).
    - Added the **maiden-over** definition and the **division-by-zero → NULL** rule to §4.1 (both already in the
      code; §4.1 just hadn't stated them).
    - **Donut** is confirmed **player-popup only** — deliberately not a Graph Builder type; its renderer is
      retained for the popup. Not returning to the builder for now.
    - **New backlog item at priority 10** — "Player pop-up — full determination": which graphs go in the
      popup + how they're shown + review of the stat blocks, which will be LINKED to the Stats column-group
      dropdown (Core/Boundaries/Dismissals/Phases/Progression) BY FORMAT. Depends on backlog #4. Full design
      re-do shifts to #11, load-speed to #12, file-split to #13.

63. **Backlog #3 — phase-component columns SHIPPED (owner 2026-07-23; scope: batting + bowling, incl. matchup,
    total dismissals per phase).** Added **84 new phase-component columns** across all four parquets — batting/
    matchup_batting get `{phase}_dots/_fours/_sixes/_dismissals`; bowling/matchup_bowling get `{phase}_dots/
    _fours_conceded/_sixes_conceded` (phase wickets already existed); phases = pp/mid/death + the odi_ trio,
    odi_* NULL for the Hundred. Purely ADDITIVE to `export_parquet.py` (existing columns byte-identical, proven
    by building from HEAD and the branch and DuckDB `EXCEPT`ing both ways = 0 rows on all 4 files). UI: five
    `PHASE_DERIVED` entries per namespace in `src/graph/timeseries.js` (dot_pct/boundary_pct/fours/sixes/
    average — bowling uses the `_conceded` suffix + `boundary_pct_conceded` key), so Dot%/Boundary%/Fours/
    Sixes/(batting)Average become chartable BY PHASE on the **Line X=Phase** view — NO query-builder change.
    - **Dismissal residual = ZERO**: every real dismissal (incl. the rare kinds — 2 timed out, 106 retired out,
      33 obstructing, 8 handled, 1 hit-twice) places into a phase; Σ(pp+mid+death dismissals) = Σ dismissed
      exactly for T20/IT20 (and odi within 50-over). matchup_batting phase dismissals mirror its credited-only
      `dismissals` (decision 23), exact per row.
    - **Anchors intact**: 2,813 / Karanbir 2,454 / SA Yadav 60·1,544·29.13·150.34 / SA Yadav vs Spin 38·454·
      SR140.99 — all reproduced; independent source recompute of the new counters matched. 20 new pipeline gates
      guard every future run.
    - **Deploy = STAGED** to avoid a broken-chart window (the pipeline auto-runs on a cron, so merge == deploy
      within ~6h): pushed the pipeline commit to main FIRST → owner ran the pipeline (GitHub Actions) → columns
      confirmed live on R2 (DESCRIBE over https, all 4 files) → THEN pushed the UI commit. Verified live on
      cricdb.vercel.app. Grouped Bars stays its own curated 2-family chart (not auto-extended); the new metrics
      surface on Line X=Phase.
    - **Size note (for load-speed #12)**: the two matchup parquets grew ~30% (matchup_batting 10.7→14.2 MB,
      matchup_bowling 13.0→16.7 MB); batting +29%, bowling +31%. Owner accepted when choosing "include matchup".

64. **Graph player-selection shortcuts gated to USABLE players (owner 2026-07-23; owner-found bug).** Top Names /
    Best / Worst previously auto-selected without checking whether a player had the data the chart needs — Top
    Names picked biggest names regardless; Best/Worst on multi-point/multi-metric charts fell back to raw seed
    order, so "Worst" surfaced no-data players. Fix (in `src/graph/graph.js` ONLY — builders/metrics/timeseries
    byte-untouched, so no number moves): all three non-manual shortcuts now auto-select ONLY players with the
    COMPLETE data the current chart needs, ranking WITHIN the usable set; fewer usable than the cap → all usable,
    zero → empty.
    - **ONE predicate** (`computeChartabilityFor`) drives BOTH the roster `[usable]` badge AND the shortcut gate,
      so they can never disagree (owner decision 2 — UNIFY).
    - **"Complete data, smart per X-axis"** (owner decision 1): fixed bucket sets require ALL buckets/members —
      Line X=**Phase** = all phases (tightened from ≥2), Grouped Bars = all phase members (tightened from ≥1),
      radar = every axis, scatter/slope/dumbbell = both axes/windows; open-ended Line X (year/innings/event/
      month) keeps ≥2 points ("all" is meaningless there); bar = has the metric; benchmark left as-is
      (single-subject). This tightening **supersedes decision 59 #3's lenient badge thresholds** (owner-authorized).
    - Re-derives on every config change (X-dim / metric / axes / windows / family), and the INITIAL auto-select
      is gated too (not just later edits); async token-guarded so a superseded derive can't overwrite a newer one.
    - **Verified**: bowling Line X=Phase Top Names picks 6 all-phase bowlers (Holder/Russell/Maxwell/Shakib/
      Moeen/Mahmudullah); independent DuckDB confirmed each has pp+mid+death balls > 0; anchors intact; 0 console
      errors. Deployed as a single UI push (no pipeline needed).
    - **Known nuance (left as-is, owner-ruled titles)**: when usable < cap, the card title can read "N most-capped
      players" where N is the usable count — i.e. the N most-capped *usable* players. Flagged, not reworded.

65. **POLISH PHASE — filter/graph overhaul rulings (owner 2026-07-24→29; all on `polish-b1-mechanical`; per-wave
    detail in `.orchestrator/progress/`).** Numbers-sacred held throughout (query builders byte-identical unless
    a ruling below is a deliberate, additive scope change; anchors 2,813 / Karanbir 2,454 / SA Yadav 60·1,544 held).
    - **Wave-6 match context** = filter-level (narrows scope): Result (Won/Lost/Drawn/**Tied**/No result — owner
      ruled Tied and Drawn stay SEPARATE), Toss result, Toss decision, Innings order, Stage, and the Event→Season
      nested picker. Super-over winner extracted from `result_type 'tie (Team)'` (108/108 exact).
    - **Result Condition** (owner redesign): a picker NESTED under Result; both default to **"All"** (adding the
      condition is byte-identical until you narrow). Options All/Normal/Super Over/D/L (Rain)/VJD (Rain)/Awarded/
      Fewer Wickets. **Super Over MOVED out of Result into Result Condition** (it's a facet of how the result
      arrived, not mutually exclusive with Won/Lost). "Normal" = `method IS NULL AND NOT super-over`. **Defect
      fixed**: `is_super_over` was NULL for 95% of rows → wrapped `COALESCE(...,false)` in export + app so
      negation (Normal) doesn't drop everyone.
    - **Event + stage NAME NORMALIZATION** (owner: "collapse names that mean the same thing"): DISPLAY-COLLAPSE
      via an app-side canonical alias map (`src/canonicalNames.js`) — dropdown shows one canonical, the filter
      expands it to all raw aliases (MORE complete + cleaner; byte-identical when nothing selected; no data
      rewrite). Owner-vetted map (`.orchestrator/event_canonical_map.json`): World Cups, County Championship,
      Vitality Blast, One-Day Cup, **CSA T20 Challenge** (MiWAY+Ram Slam+CSA — owner verified no dup matches, the
      year-overlap was a season-label artifact), the regional-qualifier fold (global + 5 regions per gender), and
      all stage spelling variants. Stage moved under Event; "No Stage" = `event_stage IS NULL`; hide the control
      only when there's truly nothing to choose (No Stage counts as a choice). **Tri-series NOT merged** — ruled
      each is distinct and should be named by teams per season-instance ("2008 Tri-Series (Australia, India, Sri
      Lanka)"); that + the Tournaments/Bi-Laterals/Tri-Series category groupings deferred to backlog #5.
    - **Cascading (cross-filtered) option lists**: every DB-derived dropdown narrows by the other active picks
      (self-exclusion; Team↔Opposition narrow each other; cache keys carry siblings). **A pick that becomes
      impossible is KEPT and GREYED, never silently reset** (owner reversed the earlier auto-reset); shown ticked
      + muted + "no matches with your current filters", still clickable to untick. Rule mirrors the offer test
      (OR across picks) so pick-order no longer matters. When the whole selection is impossible → an in-popup
      **zero-results notice** (naming the culprit, never blocking Search) + explanatory table-area empty-state.
    - **PIN RULE (owner, verbatim): "a pin changes WHO is listed, never WHAT their numbers mean."** The pin
      exemption was positional (any clause appended later silently became bypassable) → made EXPLICIT
      (`bypassableClause` in filters.js). Pins BYPASS who-to-list filters (team, profile, R.Pos, name search,
      stat conditions); pins OBEY everything defining the numbers (core scope + opposition, matchup striker
      position, event(+seasons), venue, stage, result, result-condition, toss, innings-order). A pinned player
      with no in-scope rows shows a "—" row. Graph selection given the SAME exemption as the Stats table.
    - **Best/Worst roster modes** available ONLY on a Bar chart with a DIRECTIONAL metric (`higherIsBetter !=
      null`); greyed (with tooltip) on neutral-metric Bar, Scatter (dual-metric — no single "best"), and
      Radar/Slope/Dumbbell/Benchmark. **Owner-found bug**: the ranking treated `higherIsBetter===null` as
      "lower is better", so "Best Matches" picked the FEWEST — greying replaces it. Scatter default never X==Y.
    - **No dark mode**: removed all dark-theme references from docs/comments/agent brief — there is no dark theme
      and none is planned (kept only the styles.css header's illustrative `[data-theme]` example, per owner).
    - **Read-only logic audit before deploy** (owner-requested cadence: light fresh-eyes audit of the
      selection/display layer that byte-identical checks don't cover, at the end of a big wave): confirmed clean
      bills of health on pins / cascading / normalization / toolbar; found + fixed the Best/Worst direction bug,
      a stale-async selection clobber, and a latent canonical round-trip asymmetry (hardened + a tripwire).

66. **POLISH PHASE SHIPPED + DEPLOYED to production (owner "Go for it", 2026-07-29).** Staged **data-first** to
    avoid a broken-column window (schema is additive, so the live UI keeps working while R2 rebuilds): pushed
    `export_parquet.py` ALONE to `main` → **owner ran the "Data pipeline" workflow** (workflow_dispatch; no gh CLI)
    → verified new columns live on R2 by DuckDB `DESCRIBE` over https (**schema parity across all 9 parquets**,
    `is_super_over` clean 0-null, `fielding_events` present) → THEN pushed the UI. `main` = `ea79f3f`; app live at
    cricdb.vercel.app; data at `data.the-cordon.com`. Verified end-to-end ON the production site: 2,813 players /
    Karanbir Singh 2,454 / SA Yadav 60·1,544, SKY Result-Condition=D/L 2/82, 0 console errors; CORS OK from the
    Vercel origin. **Anchor note**: the app count = distinct (batter_id, batter_name), ~3 above a raw
    distinct-batter_id (name-variant quirk) — a false "2,813→2,810 drift" scare that was a counting-method
    mismatch, not real drift. **NEXT**: backlog #4 (column-group metric defs) or #5 (dropdown taxonomy).

## 2026-07-30 — Ball-grain rebuild program (supersedes the #4-first plan)

67. **BALL-GRAIN REBUILD APPROVED (owner, 2026-07-30): the app's single source of truth becomes a
    delivery-grain ("ball layer") parquet set.** Chosen over app-side phase derivation and pipeline
    phase-column extensions — owner: "build the best possible version of data access first, then worry
    about load times" (quality over load time; load-speed work stays backlog #14, which may later add
    fast pre-aggregate parquets as caches only). Program rulings:
    - **Single source of truth**: engine v2 computes every stat from balls. NO existing parquet is
      deleted until the new flow is built + tested and we see what must be saved (`player_matches` is
      already known essential — Matches is selection-based, never derivable from deliveries).
    - **Physical split by gender × format bucket (6 files)**; the scope strip's Gender+Format picks
      which files a search reads. Orthogonal to where the window filter lives.
    - **Delivery-window filter lives in the Advanced-filters drawer** (owner ruled against a scope-strip
      control): TEAM clock = Phase (named standard windows) / Overs (custom range, e.g. 21–24 of an ODI)
      / Balls (custom legal-ball range, 1–120 / 1–300). Gating: Phase + Balls offered for T20 and
      50-Over only; **red ball shows Overs ONLY**. PLAYER clock = first/last X balls faced (batting) /
      bowled (bowling), offered in ALL formats. Team + player windows compose ("first 10 balls faced,
      in the death overs"). Clocks count LEGAL deliveries (extras ride inside the window at their
      position; batter-faced ordinal = wides-excluded per SPEC §4.1; the Hundred handled by legal-ball
      ordinal as in the exporter).
    - Windows are defines-the-numbers filters → **pins OBEY them** (the WHO-not-WHAT rule). **Innings
      under a window = innings with ≥1 ball inside the window** (decision-28 honesty pattern);
      **Matches stays selection-based** (in the XI = a match), unaffected by windows, and **stays in
      the advanced filter list** (owner considered popup-only, chose keep).
    - **Per-phase FILTER entries are REMOVED** — the window replaces them. By-phase COLUMNS remain for
      side-by-side comparison. Mixed-scope queries (a phase condition alongside full-scope columns)
      knowingly die — owner: "let the mixed queries die; by phase means everything by phase."
    - **Fixed progression metrics (SR first-10 / 11–20 / 21+) are REMOVED**, replaced by the player
      clock; may return later as columns (owner floated a custom column picker alongside presets —
      parked for the preset redesign).
    - **Super overs: included in the ball layer, flagged, UNCONDITIONALLY excluded from every player
      stat and career record** (not a filter, no toggle — they are their own section, outside any
      phase; a super over is a separate mini-innings, NOT balls 121+). Reserved for a future dedicated
      super-over records surface.
    - **Column presets (backlog #4): parked entirely; redesigned FROM SCRATCH after this program**
      (owner rejected the orchestrator's 2026-07-30 preset proposal). Backlog #9 (per-over layer) is
      absorbed by this program.
    - **Step 0 (approved to start)**: measurement + design only — build prototype ball parquets
      LOCALLY from data/cricket.duckdb (git-ignored), weigh all 6 splits, reproduce the standing
      anchors from balls, and report a measured current-vs-future load/search time comparison
      (real R2 bandwidth applied to new sizes + in-browser compute on localhost). Nothing ships;
      no repo code, pipeline, or R2 touched.
    - **Extras attribution — RULED (owner, 2026-07-30; was flagged open):** an extra rides into the
      UPCOMING legal ball's slot on any clock that doesn't count it (team_ball + bowl_ball for wides
      AND no-balls; bat_ball for wides only — a no-ball IS a genuine faced ball). Identical to
      export_parquet.py's `legal_ordinal` and today's phase columns, so window totals stay consistent
      with shipped numbers. For the bowler an extra's RUNS count (economy), the BALL does not.
    - **Illegal-ball wickets — CONFIRMED (owner, 2026-07-30):** bowler-credited kinds are credited
      regardless of delivery legality (matches the shipped export); run-outs are not (already excluded).
      Verified in data: 539 bowler-credited wickets on illegal balls (531 stumped-off-a-wide — legal
      cricket — + 6 hit-wicket + 1 bowled + 1 caught; the last two are cricket-impossible → 2 Cricsheet
      source errors, left as-is to keep numbers-sacred). No change.
    - **SPEED PULLED FORWARD (owner, 2026-07-30, after Wave 2a):** Wave 2a proved the ball engine
      byte-identical (45 scenarios, 0 mismatched cells; anchors from balls on screen) but ~19.8 s per
      flag-ON search (orchestrator-confirmed) vs ~0.2 s flag-OFF — cause: reconstructing all ~74 innings
      columns per search in WASM (~6× native, single-core) when a search uses ~8–10. Owner: "20-second
      searches are unacceptable" → the load-speed work (old #14) runs NOW, before Wave 2b/3, and
      HARD-GATES Wave-4 cutover. Approved plan: **Layer 1** query-shaped (column-pruned) reconstruction —
      engine builds only the columns the current search uses, conservative fallback to full set;
      **Layer 2** lean base projection (no SELECT *) + a scope-keyed materialization cache so column
      adds / graph queries / popup opens within one Search reuse the computed table. **Layer 3 —
      production mode (pure single path vs innings-parquets-as-validated-cache for windowless
      searches) — is an OWNER DECISION deferred until Layers 1–2 are measured.** Threads via
      COOP/COEP headers parked (infra/CORS churn) unless measurements disappoint.
    - **Wave-3 window CONTROL design SIGNED OFF (owner, 2026-07-31: "do it as you suggest"):** ONE combined
      "Delivery window" drawer entry, two composing sub-sections — **Team innings** (mode toggle Phase [multi-
      select PP/Mid/Death] / Overs [from–to, format-capped] / Balls [legal team balls]; red-ball shows Overs
      ONLY; Phase+Balls offered only under a single T20 or 50-over bucket) + **This player** (First/Last N balls
      faced [batting] / bowled [bowling], per-innings, ALL formats, works on the leaderboard per-row AND in the
      popup). Windows compose; it is a defines-the-numbers filter → Search-gated + pins OBEY it; pill + honest
      scope line from `describeDeliveryWindow`; the control is shown only when the ball engine is active. Labels
      "Delivery window"/"Team innings"/"This player" accepted. **Case-(f) semantics DEFERRED** to the post-
      rebuild column/filter cleanup pass (owner: "we take a detailed look then"): a player-clock composed with a
      team window currently counts innings by the literal decision-67 "≥1 in-window BALL" rule, so a
      crease-present-but-didn't-face innings still counts (SA Yadav first-10∧death = 11 inns vs 4 faced) — that
      rule STANDS until the cleanup revisits it. Wave-3 ENGINE verified (windowed anchors reproduce from raw
      balls: death 185/96/192.71, first-10 634/476/133.19, death-inns 13); commit 7474203. UI build = next.
    - **DESIGN CORRECTED at the UI-A review (owner, 2026-07-31):** the combined single "Delivery window"
      entry with a Phase|Overs|Balls mode-TOGGLE is a "deprecated design style" — REPLACE with SEPARATE,
      uniform "+ Add condition" entries, one per option (**Phase** [multi PP/Mid/Death] · **Over range** ·
      **Ball range** · **Player balls** first/last-N faced|bowled), each its own filter + pill, gated in the
      dropdown per format (Phase/Ball-range T20+50-over only; Over-range all incl. red-ball; player-clock all),
      composing freely (contradictory combos → honest empty). Reason: a toggle FORCES one mode and breaks the
      uniform per-filter pattern (cf. decision 42). Rework needed a flat composable spec
      `{phase?,overs?,balls?,player?}` (AND of pieces) inside the pure generator; numbers byte-identical.
      Built + orchestrator-verified (commit a430ea6): 4 separate entries confirmed in the DOM, old combined
      widget gone, composed window (Death ∧ first-10 = SA Yadav 25 runs, predicate = the two clauses AND-ed)
      correct, walls untouched branch-wide. See memory [[feedback-uniform-filters]].
      **Owner (2026-07-31): "yes it's in there" — the four-entry STRUCTURE is accepted; the EXACT/detailed
      control design (layout, labels, styling) is DEFERRED to the later filters/columns rejig pass (same pass
      as the from-scratch preset redesign) — do NOT polish it further now.**
    - **Wave-3 Part B (window controls in Graphs popup + player pop-up) FOLDED into the filters/columns rejig
      (owner, 2026-07-31: "no point redoing the player filters twice").** The window ENGINE is global, so
      Graphs/popup already INHERIT the applied window (shown in their scope footer) — they just lack their own
      window control until the rejig wires it. So Wave 3 = window live on Stats; nothing is broken cross-surface.

68. **FILTER REJIG — full design SIGNED OFF (owner, 2026-07-31); build spec = `.orchestrator/filter-rejig-spec.md`.**
    First of the post-ball-layer filters/columns rejig (owner sequence: filters → columns → columns-in-filters-
    popup → presets-from-scratch). The complete "+ Add condition" redesign — new groups (Player Profile · Match
    Details · Basic Stats · Detailed Stats · Ball Ranges · Matchup (Vs) · Fielding Stats), ~60 flat metric rows
    collapsed to sub-filters (▸ = one entry → variant → operator → value), per-phase + progression filters
    DELETED (subsumed by the delivery window = "Ball Ranges"), a batch of renames (numerals + clarity: NBSR,
    Boundary Ball %/Boundary Run %, Batting/Bowling Strike Rate, 50s/100s, 5-WI, Innings Number, Match/Toss
    Result, Batting Position, etc.), and a few new metrics (Boundary Run % bowling, Innings Score ≥ N, Extras,
    Innings Number, generalised Wicket Hauls ≥ N, expanded % Runs in…). **Part B** (window controls on Graphs +
    player pop-up) folds into this rejig. Full detail + build notes in the spec doc — NOT re-narrated here
    (pointers-not-copies). Standing rules reinforced this session: NEVER cut a filter for being niche (3rd
    correction — see [[feedback-no-data-policing]]); uniform per-option filters, no bespoke widgets
    ([[feedback-uniform-filters]]); verify names/labels/formulas against code before asserting (owner caught
    "Running SR"/"Boundary % Conceded" mislabels). Columns rejig is NEXT.
    - **Step-0 OUTCOME (2026-07-30): PASS → Wave 1 GO.** 6 files built locally; the first-draft schema
      was 8 numbers short (gave 3,012 not 2,813) → schema **v1** adds 4 cols (non_striker_name/position,
      bowler_credited_wkts, wickets_extra) and reconciles BYTE-FOR-BYTE to every existing export; all
      anchors reproduce from balls; total 76 MB (SMALLER than the 79 MB of innings/matchup files it
      retires); warm full-leaderboard search ~0.35 s in DuckDB-WASM, windows free; real bandwidth ~10 MB/s.
      Owner ruled: STORE bat_ball_rev/bowl_ball_rev (simpler/faster, ~11 MB).

69. **HARMONISATION + REJIG PROGRAM + PLAYER-POP-UP TAB 2 (owner, 2026-08-02→03).** All on `ball-layer`,
    flag-gated; NOTHING shipped. Plans: `.orchestrator/harmonisation-rejig-plan.md`, `.orchestrator/popup-ballengine-plan.md`,
    `.orchestrator/filter-rejig-spec.md`, `.orchestrator/control-audit.md` (pointers-not-copies). Anchors held throughout
    (2,813 / Karanbir 2,454 / SA Yadav 60·1,544·29.13·150.34).
    - **Full picker harmonisation to ONE design language, foundation-first** (option C search palette; dates =
      searchable month-list; all categorical multi-selects = checkbox panel, **chips retired**, segmented toggles
      ONLY for exclusive on/off; **discipline → dropdown everywhere** — decided but DEFERRED to the sweep).
    - **DONE + verified (leaderboard filter rejig): Wave F** (unified panel `searchSelect.js`; segmented-toggle
      standard; profile pickers/R.Pos/Gender/Discipline migrated) **and Wave R** (the palette: 7 groups, ▸
      sub-filters, renames, deletes, delivery-window→Ball Ranges, new metrics, Innings Number filter, Fielding
      Wicket Type count operator, MAT-innings-level, matchup-bowling Boundary Run %, Caught & bowled, dead-code
      cleanup). Mechanical audit confirmed **no silent removals**. Commits `acbb9a1`→`bd9bf08`.
    - **Player pop-up = Option 3 (rebuild on the BALL ENGINE).** P0/P1 done (`b942be1`; pop-up already computes
      byte-identical on balls, zero code change). **Tab 2 "Filters" design SIGNED OFF** — a rows-as-slices table
      (each row a full-palette multi-condition slice, **Reading A**; shared REAL leaderboard columns/presets;
      scope in a filters popup mirroring the leaderboard **minus Gender**; row-name = first filter + (i) shows all;
      edit=pencil + inline ✕; sort/pin like the leaderboard; no baseline row; per-tab discipline; lean). Profile
      filters + PotM dropped from the pop-up **FILTERS only** (Team kept; columns untouched = columns rejig's call).
      **NEW opponent-player filter** (X vs Y; ball engine `bowler_id`/`batter_id`; Tab 2 + main leaderboard).
      **Build off the REAL components** (every hand-mock hallucinated). **⛔ STUCK on the T0 mock** — restart there.
    - **AND/OR filter logic** = a design pass AFTER the columns rejig (main popup + player pop-up).
    - **Order (confirmed):** player pop-up Tab 2 (active) → columns rejig → columns-in-popup + presets → AND/OR →
      sweep → review → cutover (LAST). Process rule reinforced + codified in `CLAUDE.md` **Rule 3**: I execute, the
      owner is PM; ask before building; no unilateral scope/order changes; no decisions smuggled into asides.

70. **PLAYER POP-UP "FILTERS" TAB — design finalised + build plan approved (owner, 2026-08-03).** Follows #69.
    Full design detail: `.orchestrator/popup-ballengine-plan.md`; build plan: `.orchestrator/popup-tab2-build-plan.md`
    (pointers-not-copies). Branch `ball-layer`, flag-gated `?engine=ball`; NOTHING shipped. **T0 mock SKIPPED**
    (owner: "you understand the design well enough"). Numbers sacred: a no-filter row == that player's leaderboard
    row (byte-identical); `buildQuery` reused UNCHANGED, scoped per-player via the existing outer-wrap idiom.
    - **Terminology (final):** add button AND the editor commit button are both **"Add Filter Row"**; edit =
      **pencil icon** (never the word) + inline **[✕]**, both on the row-title line; row label = the first condition
      in **LITERAL operator form** (e.g. `Innings Score ≥ 100`); **(i)** reveals the full condition list (bare);
      empty state = **"No filtered rows yet"**. **The word "slice" is RETIRED from ALL user-facing text** (owner
      asked twice — internal shorthand only).
    - **Scope:** Format / Team type / Date are **PER ROW** (set inside each Add Filter Row popup; **sticky** —
      pre-filled from the last row added); **no separate scope popup / Filters button**. **Discipline is SHARED for
      the whole tab** (all-batting OR all-bowling; never mixed — column-name standardisation).
    - **The old "Player Filters" overlay is RETIRED** — the new tab-system replaces it (owner-approved removal).
    - **Column picker EXTRACTED into a shared component** (reuse, not copy — foundation-first); the tab's column
      choice is **INDEPENDENT** of the leaderboard's.
    - **Build plan approved; Wave A (foundations) authorised.** SPEC/BACKLOG doc updates HELD until the ball-layer
      cut (Option B).

71. **PLAYER POP-UP OVERALL REVIEW + FIX WAVE — DONE (owner, 2026-08-06→07).** Follows #70. All on `ball-layer`,
    flag-gated; NOTHING shipped. Docs (pointers-not-copies): `.orchestrator/popup-review-findings.md`,
    `popup-fix-plan.md`, `gender-to-data-plan.md`, `popup-review-R5-group3.md`. Anchors held byte-identical
    throughout, flag-off AND flag-on (2,813 / Karanbir 2,454 / SA Yadav 60·1,544·29.13·150.34; matchup vs Spin
    38·454·140.99, Bumrah vs RHB 27·177·9).
    - **Overall review** = 4 independent checks (fresh-eyes code; flag-off runtime; independent DuckDB recount;
      flag-on `?engine=ball` runtime) → **0 blockers**, a short cleanup list.
    - **Owner rulings this session:**
      • **Hide the literal "Unknown" tick-box** from the fielding "Batter role" filter (out_role) — keep the filter
        itself; matches the app-wide `playing_role==="Unknown"` drop (2026-08-06). **[SUPERSEDED by decision 76.1
        (2026-08-26): the whole fielding "Batter role" filter was later REMOVED, not just its Unknown option.]**
      • **Gender hardcode removed END-TO-END → DATA-DRIVEN everywhere** (2026-08-06/07). Extends the offer-path
        ruling ([[feedback-data-driven-filters-not-gender]]) into the **NUMBERS path** (`matchupVsActive` /
        `profileSemiJoinSql` now key on a resolved per-gender `state.dataAvail` map — new `src/dataAvailability.js`,
        wired in `main.js`; the Search commit awaits it; byte-identical today) AND the **DISPLAY path** (`table.js`
        toolbar Vs control). Owner: "no reason for this to be men only — data only; a lot of MALE players also lack
        this matchup/profile data." Women's matchup/profile features auto-appear when women's data lands.
      • Fix set approved: Group A (cleanup: slice word, dead code, hidden Unknown, dropdown leak) + Group B (engine
        cache key) + the toolbar-Vs sweep. Item-7 dropdown fix done **"properly, not later"** (real close() surfaced
        on the shared drawer editors, not a click hack).
      • Sourcemap-404 nit → **BACKLOG #16** (defer to the design/chart-review stage).
    - **A fresh Opus review of the gender→data change caught 1 real BLOCKER** (the graph read stale availability for
      women with a persisted matchupVs) → fixed (clear matchupVs on gender switch). Fix-wave commits `8064c3d`
      `0ba0fef` `3b58acb` `ecb49ae` `a3a4332` `5aef338`.
    - **NEXT (unchanged order):** columns rejig → columns-in-popup + presets → AND/OR → sweep → review → cutover
      (LAST). SPEC/BACKLOG docs **UPDATED 2026-08-07** (owner lifted Option B, #70) — reworded "built on branch,
      not yet live" + committed; no longer held.

## 2026-08-15 — Composers + Fielding-scope (rework Chunk 2-3)

72. **STANDALONE COMPOSERS (Team/Opposition/Stage/Event/Venue) — BUILT + COMMITTED** on `ball-layer`, nothing
    pushed (commits `2445f7a` `2da95c2` `9936a14` `dc08c24` `3c6d0a9` `2594682`). Build plan:
    `.orchestrator/rework-composers-build-plan.md`. Anchors byte-identical throughout (2,813 / Karanbir 2,454 /
    SA Yadav 60·1,544·29.13·150.34); every composer value independently DuckDB-verified.
    - **Composers are STANDALONE and INDEPENDENT of the scope filters — CORRECTS the earlier rework spec.** The
      "filter drives the composer" / "composers auto-generate one column per selected filter value" idea in
      `.orchestrator/filter-column-rework-spec.md` §3/§5 is **REJECTED** (owner: "WHY HAVE YOU CONFLATED TWO
      UNRELATED FILTERS"). A composer = pick value(s) × a stat, standalone, via its own picker; there is no
      "default stat" and no "breakdown" concept (both were the executor's invented terms, also rejected).
      Neither drives nor is driven by any same-named filter. Spec doc corrected in place 2026-08-15.
    - **Value-picking:** short fixed sets (e.g. Batting Position) keep the checklist; the four long/data-driven
      sets (Team/Opposition/Event/Venue) reuse the SAME searchable multi-select (`searchSelect.js`
      `mountSearchMultiSelect`) the corresponding FILTERS already use — NOT the matchup "Vs" picker (a short
      list). No column cap (table scrolls; extreme tick-counts self-limiting).
    - **Clean/canonical names where a fold exists** (Event via `eventAliases`, Stage via `stageAliases`); raw
      spelling where none exists (Venue).
    - **"No Stage" left AS-IS.** The Stage composer offers a "No Stage" bucket (`event_stage IS NULL`, reusing
      the Stage filter's own `STAGE_NONE` sentinel). Owner reviewed what this bucket means — stage not recorded
      in the data (≈ tournament group/league stages Cricsheet leaves unlabelled, plus bilateral series) — and
      chose to **leave it as-is** (no relabelling, no further splitting).

73. **FIELDING AS A THIRD LEADERBOARD SCOPE — foundation + full filter set BUILT + COMMITTED; auto-columns
    PENDING** (commits `9fe295f` `a3dbb8e` `bc18195` `3efdc01` `414508c`). Build plan:
    `.orchestrator/rework-chunks-2-5-build-plan.md` Chunk 3. Anchors byte-identical throughout; batting/bowling
    untouched.
    - Fielding is a third "discipline" option that ranks FIELDERS, mirroring the player pop-up's existing
      fielding MODE (namespace "batting" + a fielding flag — there is **no separate "fielding" metrics
      namespace**).
    - **Fielding is EVENT-GRAIN — no innings concept — so the denominator is Matches**, i.e. `player_matches`
      appearances (NOT a bespoke new source — the executor's reinvention of a fresh tally was rejected in
      favour of reuse). Default columns: Matches · Catches · Stumpings · Run-outs · Total dismissals; default
      sort Matches-desc.
    - **Fielding Matches REUSES the existing batting/bowling `inningsLevel` switch:** un-narrowed → appearances
      (`pmatch`); narrowed (an opposition or a fielding slice active) → matches-with-a-credit (`fld_matches`).
      **The player pop-up's fielding Matches was FIXED to use the same switch** — it previously always used
      `fld_matches`, disagreeing with the leaderboard.
    - Count-threshold filters (Catches/Stumpings/Run-outs/Total dismissals/Matches/Caught & bowled ≥ N) reuse
      the existing `conditionToHaving` machinery — no new filter mechanism built.
    - **Final fielding filter menu (6 groups):** Fielder Profile (Matches · Team) · Match · Ball Ranges ·
      Wicket Types (Catches · Caught & bowled · Stumpings · Run-outs · Total dismissals) · Bowler Details ·
      Dismissed Batter (position · dismissed batter hand · role · specific batter). The old fielding "Player
      Profile" group and the redundant standalone "Wicket type" picker were REMOVED (folded into Wicket Types).
      **[UPDATE — decision 76.1 (2026-08-26): the "role" entry in this Dismissed-Batter list was later REMOVED
      entirely; the group is now position · dismissed batter hand · specific batter.]**
    - **Batting-hand on the fielding menu is owner-approved** (extends decision 54 — the bowling board still
      hides it). Data facts confirmed during the build: the only 4 fielder-credited dismissal types are caught /
      caught & bowled / stumped / run out (all covered); Run-outs count fielder CREDITS (a two-fielder run-out
      credits both fielders).
    - **NOT built:** fielding's own "every-filter-gets-a-column" auto-columns (the Chunk 2 pattern not yet
      extended to fielding's ~10 filters); Chunk 4 (cleanup sweep); Chunk 5 (the two-dropdown Player/Scope
      reorg + Match-all/Match-any AND/OR) — including the fielding filters' own Player-vs-Scope split, which
      the owner flagged as **UNDETERMINED**.

74. **STAGE-3 SPOT RULINGS (owner, 2026-08-25, during Phase 0 of the Stage-3 fix programme):**
    - **Date inputs are DAY-PRECISION everywhere** (native calendar `type="date"` — "Date inputs - day
      precision please"). This SUPERSEDES the dates half of decision 69 ("dates = searchable month-list
      everywhere") — that target is retired, and the harmonisation sweep must NOT convert date inputs to
      month-lists. All four current date-input sites (filters.js, table.js, playerFilterEditor.js,
      playerFieldingEditor.js) already use day precision, so no build was needed.
    - **The preset indicator jumping to "Custom" is CONFIRMED correct** ("Jump to custom confirmed"): whenever
      the shown columns differ from a preset's exact list (e.g. a filter has auto-added a column), the
      indicator reads "Custom".
    - **%-columns offered only through their paired count column's toggle is CONFIRMED correct** ("Only
      through the count column's toggle is confirmed") — the columns-picker pairing stays as built.
    - **The fielding board's Stage filter gains a "No Stage" option** ("Yes, add No Stage to fielding as
      well") — mirroring the batting/bowling Stage filter, which already offers it (STAGE_NONE sentinel =
      `event_stage IS NULL`). Fielding-only change; batting/bowling untouched.
    - **The cross-discipline columns dropdown gets tidy family controls** (owner picked this over hide-the-
      loose-entries or leave-as-is): when the board is on one discipline and the OTHER discipline's columns
      dropdown is opened, enumerated metric families (% Runs in…, % Runs Conceded in…, wicket types) render
      as ONE collapsed family control exactly as they do in the own-discipline dropdown — every column stays
      reachable, one design language. This is the fix for the owner's reproduced "% Runs in 1s/2s/3s as
      separate rows, no matchup" sighting (root cause: columnsPicker.js `crossSource` never applied the
      D3/D4 enumerated-hidden-keys exclusions the own-discipline list applies). Display-only.
    - **Matchup (Vs) mode must ALSO show tidy families — "I don't want loose flat rows anywhere"** (owner,
      2026-08-26). In matchup mode the columns dropdown currently renders "% Runs in…" and the wicket-type
      Dismissals section as loose flat rows (a different underpinning from the plain/cross families — matchup
      metrics are statically catalogued under matchup_batting/matchup_bowling, not the rs__/wt__ composed-key
      scheme). Build a tidy-family presentation over the matchup metrics THAT EXIST — display-only,
      buildMatchupQuery untouched, no invented metrics. NOTE (to confirm, not yet ruled): matchup mode appears
      to register FEWER variants than plain mode (e.g. 3 of 8 % Runs sources); the tidy family shows exactly
      what exists — whether to ALSO add the missing variants (a separate numbers/data question) is NOT decided.

75. **MATCHUP VS EXPANSION (owner, 2026-08-26):**
    - **Metrics to add:** the "% Runs in…" family (batting, full set) + the "% Runs Conceded in…" family
      (bowling, full set). NOT ball tallies / milestones (50s/100s/ducks/not-outs) / maidens / N-fors /
      innings-score≥N — those are innings/over-level achievements that don't decompose by opponent bucket.
      Presented as TIDY FAMILIES (no loose flat rows — ratifies the tidy-families note in decision 74).
      Computability (verified, .orchestrator/progress/matchup-pctruns-computability.md): batting 5/5 + bowling
      4s/6s buildable now (metrics.js only); bowling non-boundary/wides/no-balls need an export_parquet.py add
      (wides_runs, noball_runs) + a data re-run.
    - **Axes:** ADD **vs bowling arm**, **vs PotMs** (performances against the Player-of-the-Match), **vs a
      specific opponent** (extend the player popup's to the leaderboard). Existing: vs bowling style, vs batting
      hand. NOT vs playing role, NOT vs batting position.
    - **Container / UX (owner ratified the orchestrator's opinion):** a DEDICATED "Matchup" dropdown — a third
      alongside Player / Scope — reflecting that Vs is a distinct MODE (it changes the unit of analysis, your
      innings → your deliveries vs a bucket), NOT a simple toggle and NOT loose discrete rows. Inside it,
      "**define the opponent**": ONE composite opponent definition built from the SHARED attribute pickers
      (style / arm / hand / PotM status / specific player), reusing existing controls — no duplicated filter
      list. Mental model = Player (who you are) · Scope (which matches) · Matchup (who you faced). To be MOCKED
      + detailed at the Phase-3 design sitting BEFORE build.
    - **Data / sequencing (orchestrator RECOMMENDATION, not yet ruled):** the buildable-now % Runs metrics ship
      near-term; the data-gated pieces (vs arm + vs PotMs axes; the 3 bowling % Runs Conceded variants) need a
      data-layer add — recommended to fold into the ball-layer cut (matchup rebuilt from raw balls → they come
      free) rather than a throwaway parquet patch + re-run, unless the owner wants them sooner.

76. **STAGE-3 PHASE-3 DESIGN SITTING — RULINGS (owner, 2026-08-26):**
    1. **Fielding "Batter role" (out_role) filter: REMOVED — confirmed.** SUPERSEDES decision 71's "keep the
       filter, hide only its Unknown tick-box" and the "role" entry in decision 73's Dismissed-Batter group
       list — the WHOLE filter is gone (code 3db8a5d / 0864148 + the leaderboard-side removal). Those two lines
       are tagged superseded.
    2. **The Feature Ledger's permanent home = `review/FEATURE_LEDGER.md`** (committed, beside this log),
       promoted from its `.orchestrator/` working copy. It is the durable conformance record.
    3. **Column-dropdown count badges: RESTORE** — each of the four column dropdowns shows a live count of the
       columns chosen in it (built once, silently lost).
    4. **"Group rows / Split by" toolbar control: DEFERRED (not built for launch)** — after the explanation,
       owner ruled it not needed for now: the same per-value breakdown is already reachable per-player in the
       player popup, so it's a demand-driven post-launch beat, not a gap. Logged in `review/POST_LAUNCH_FEATURES.md`.
    - **NEW LOG (owner, 2026-08-26): `review/POST_LAUNCH_FEATURES.md`** — a running list of small, standalone
      features parked before launch, each deployable afterwards as its own update / marketing beat to drive new
      users. Distinct from `review/BACKLOG.md` (pre-launch work). Seeded with item 4 (Group rows) and item 6
      (Add Group / nested condition groups). Maintain it whenever a feature is parked "add later if demand".
    5. **Rank-by-first-filtered-column: RESTORE, with a rule** — only a filter whose auto-added column is a
       RANKABLE (numeric/sortable) metric drives the auto-sort; a filter whose column is NOT sortable (a
       which-values list/text column — Opposition, Stage, Venue, …) does NOT re-sort, the table stays on its
       innings-count default. The sort indicator must make clear what the table is ranked by. (Consistent with
       decisions 44/61: never sort by something the user can't see/understand.)
    6. **"+ Add Group": KILL the non-functional control for now** (remove the dead button); revisit only if
       there is demand for nested condition groups.
    7. **Highlight toggle: KEEP staged-until-Search** (timing unchanged) but **CHANGE the misleading pencil
       icon** (new glyph + a clearer "pending until Search" cue — mock to follow).
    8. **Match-any visibility: owner wants MOCK OPTIONS** for surfacing which conditions are OR'd vs
       always-applied (Ball Ranges / matchup Vs stay always-AND under Match-any).
    Build items 3/5/6 land at Phase 4 (build the sitting's outcomes); 7 (icon) + 8 go to mocks first;
    item 4 awaits the owner's decision after the explanation.

77. **STAGE-3 PHASE-3 MOCK REVIEW — RULINGS (owner, 2026-08-26)** on .orchestrator/phase3-mocks.html:
    1. **Highlight icon = Option C** (the spotlight/marker glyph — replaces the misleading pencil).
    2. **NO "pending until Search" cue anywhere; highlighting is INSTANT** — REVISES decision 76.7's
       "keep staged" framing. Rationale (owner): highlighting a column in the RENDERED TABLE is an instant
       view action like sort / drag-reorder / column-resize — it does not wait for Search. In the leaderboard/
       player popups, highlight applies on Search WITH the rest of the staged config, so a per-highlight
       pending cue is redundant (the whole popup is staged). Highlight is display-only (a repaint, not a
       re-query), so instant is safe. Build = the Option-C icon + ensure table-side highlighting is instant.
    3. **Match-any visibility = Option C** (visually distinguish the OR'd conditions from the always-applied
       ones) **condensed to a SINGLE LINE** so the results toolbar doesn't get cluttered.
    4. **Matchup dropdown = the collapsed / progressive-disclosure ("closed") layout** — the define-the-opponent
       axes start CLOSED and expand on demand, not all-axes-open. [Orchestrator interpretation of "closed drop
       down" — confirm at build.]
    5. **Column resize = NO highlight/glow** — just the cursor changing to the resize icon on hover
       (spreadsheet-standard); the glow/grip-dot options are dropped.
    6. **Pick-flash = Option A (the flash) but WITHOUT the tick boxes** — just the brief selection flash; the
       checkbox visual is dropped (owner: "quite ugly").

78. **RANK-BY-FIRST NARROWED + DATA-GATED MATCHUP GO-NOW (owner, 2026-08-26):**
    - **Rank-by-first fires ONLY for a numeric STAT-CONDITION filter** (Runs/Average/Strike Rate/%s/Innings
      Score/etc.). The three categorical filters that auto-add a COUNT column — **PotM (Y/N), Match Result,
      Toss Result** — do NOT trigger a re-sort; the table keeps its default (innings) or the user's already-
      chosen sort. Amends the as-built broad reading (commit 1c68658, which re-ranked on any numeric column).
      Build = a small state.js change (require the newly-active filter to be a stat condition, not just its
      column to be numeric).
    - **Terminology clarification (owner):** the auto-sort is NEVER "silent" — a table can only ever be sorted
      by a VISIBLE column (decisions 44/61), so a re-rank is always shown on screen (the column is present and
      the sort indicator points at it). The orchestrator's earlier "silently re-rank" wording was inaccurate.
    - **Data-gated matchup: DO NOW (reverses decision 75's recommended defer-to-the-cut).** Owner agreed doing
      it now does not add net complexity to the ball-layer cut (the cut reconstructs matchup regardless). (a)
      the 3 bowling "% Runs Conceded in…" variants (non-boundary/wides/no-balls) via an export_parquet.py add
      (wides_runs, noball_runs, mirroring bowling_innings) + an owner-triggered data re-run, staged data-first;
      (b) the new axes vs bowling arm + vs PotMs paired with the Matchup-dropdown (M2) build (vs-PotMs needs
      PotM status joined into the matchup aggregation — the most involved piece).

79. **DASHBOARD GOES BEHIND THE MEMBERS PAYWALL PRE-LAUNCH (owner, 2026-08-26):**
    - The stats dashboard + the `data.the-cordon.com` cricket-data layer move **behind the members
      entitlement** (built by the separate "The Cordon" backend folder) **before launch**. Today all of it
      is public — R2 public-read, public GitHub repo, public Vercel (`cricdb.vercel.app`).
    - **Same founding membership + price** initially; keep the design flexible so parts can stay public
      later for marketing (a partial-public split is NOT yet decided — build everything gate-able so it
      stays possible).
    - **Sequencing:** done AFTER the members/entitlement layer exists; the gating work is owned by THIS
      (cricdb/data) folder's own session, not the backend build — but it reuses that entitlement layer.
    - **Technical constraint:** whatever gates the data must preserve HTTP `Range`/`Content-Range` (signed
      R2 URLs or a range-passing Worker proxy) or DuckDB-WASM's client-side query model breaks. Also
      entails taking the repo private + moving off public Vercel onto a gated `stats.the-cordon.com`.
    - Backend handoff context lives in the local-only (gitignored) `pre_launch_handoff/` pack.

80. **MATCHUP EXPANSION — UX HOME + AXIS TRIM (owner, 2026-08-26):**
    - **The Matchup control is a THIRD LANE inside the Filters popup**, a peer to the existing Player Filters
      and Scope Filters lanes — NOT a toolbar element. **The toolbar's native "vs" select is LEFT UNTOUCHED**
      (the R3 ruling "keep the toolbar tight, Vs stays native" stands; L-015 / Gate B unchanged). This CORRECTS
      decision 75's "the Matchup dropdown becomes the home, reconcile the toolbar Vs" wording — there is NO
      toolbar reconciliation and the mock's three-dropdowns-across-the-toolbar look is NOT built (that mock
      diverged from the real toolbar, which is one Filters button → popup lanes). The Matchup lane is the home
      for "define the opponent" (collapsed / progressive-disclosure per decision 77.4), reusing the shared
      attribute pickers — it and the untouched toolbar quick-Vs both write the same state.matchupVs.
    - **vs bowling arm axis: DROPPED** — the bowling_arm profile data isn't well-mapped (a large "(unmapped)"
      bucket; arm isn't determined by bowling style), so it's not a reliable filter axis. Removed from the
      pipeline (M2b) too. This overturns the vs-arm part of decision 75.
    - **Final Matchup axis set:** vs bowling style + vs batting hand (existing) · vs PotMs (new, BOTH boards,
      confirmed) · vs a specific opponent (new; frontend-only — filters on the bowler/batter id already present,
      no pipeline column). NOT vs bowling arm, NOT vs playing role, NOT vs batting position.

81. **MATCHUP AXES — COMBINABLE (ALWAYS ALL) + LANE MEMBERSHIP (owner, 2026-08-27):**
    - **Matchup opponent axes are COMBINABLE and always AND (ALL), never ANY.** Different opponent DIMENSIONS
      combine (e.g. vs Spin AND vs PotMs AND — with scope — vs Australia). SAME-dimension values are mutually
      exclusive (never vs Spin AND vs Pace; never vs Australia AND vs India). So each axis holds ONE value;
      multiple axes AND together; matchup is never OR. This is the "one composite opponent" of decision 75/80.
    - **Engine implication (numbers-sensitive):** today buildMatchupQuery applies ONE bucket clause
      (state.matchupVs = a single {dim,value}; table.js ~416-418). Combinable requires extending it to apply a
      SET of bucket clauses AND-ed together, and state.matchupVs → a composite (axis→value map). ADDITIVE /
      byte-identical when zero or one axis is active; the anchors (SA Yadav vs Spin 38/454/140.99; Bumrah vs RHB
      27/177/9) are the single-axis cases and must stay exact. Full numbers ritual + independent DuckDB for any
      combined case. Build in a FRESH session (this one ran long).
    - **vs a specific opponent player → belongs IN the Matchup lane** (it IS an opponent axis). Migrate it out of
      the leaderboard Scope palette when wired (atomic — never double-offered, never unreachable). Naming a
      specific opponent fixes that player's attributes, so it is effectively exclusive with the attribute axes.
    - **Batting position (strikerpos) is a SELF attribute** (the striker's OWN position), NOT an opponent
      attribute — conceptually a Player/Scope filter, not a "define the opponent" axis, though it stacks with a
      Vs bucket. It sits under the Scope "Matchup (Vs)" heading today (Chunk-5 placement). PLACEMENT — owner to
      confirm: KEEP it a Scope/Player filter (orchestrator recommendation — it describes you, not the opponent),
      or ALSO surface it in the Matchup lane as a "my position vs this opponent" qualifier. Not an opponent axis
      either way.
