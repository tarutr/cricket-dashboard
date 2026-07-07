# D4 Step 1 — Metric & Filter Expansion: Exploration & Proposal

**Read-only exploration. Nothing is built yet — this is a menu for you to pick from.**
Every number below is measured from the live database copy (with `player_profiles`
built) and the current export parquets; reproduce them with `analysis/d4_explore.py`.

Scope reminders baked in: profiles are **men-only by design**, so every profile-powered
feature is effectively **men-only** in practice (women's numbers below are 0% — that is
correct, not a bug). Career-compare mode is **shelved** and is excluded here. "Recent"
means the **rolling last three years** counted back from the most recent match in the
data (2026-07-02 → since 2023-07-02), per your earlier ruling.

---

## Part 1 — Candidate metric menu

The site currently ships four aggregates: `players`, `matches`, `batting_innings`,
`bowling_innings`. A few "splits" people often ask for are **already possible today**
with no new data, because the raw ingredient is already on the per-innings rows. The
genuinely new families need either new columns or new files. The table separates the two
so you can see what's cheap.

| # | Metric family | Example metrics | What it needs | Rough size | Coverage / caveats | Cricket-sense note |
|---|---|---|---|---|---|---|
| A | **Batting-position splits** | Average / SR when opening vs at No. 3 vs finishing | **Nothing new** — `batting_position` is already on every batting-innings row (positions 1–11 all well populated: 49,044 innings at No. 1 down to 16,809 at No. 11) | 0 | Position = order of first appearance in the `batter` column (reference-doc definition). A No. 3 who is promoted/demoted mixes roles — honest but blunt. | Solid, universally available. Pure UI work. |
| B | **Opposition splits** | Runs / SR / economy vs each opponent team | **Nothing new** — `batting_team`/`bowling_team` are already on both innings files | 0 | Franchise renames fragment the opponent list (see venue/team note below). International splits are clean; club splits are noisy. | Cheap. Best surfaced as "vs country" for internationals. |
| C | **Batter dismissal-type breakdown** | % bowled / lbw / caught / run-out; "falls lbw X% of the time" | **Nothing new** — `dismissal_kind` already on batting-innings rows | 0 | Full 14-kind vocabulary present (caught 195k, bowled 68k, lbw 39k, run-out 22k, stumped 9.4k, down to timed-out ×2). | Cheap and rich. Just needs UI grouping. |
| D | **Bowler wicket-type breakdown** | Bowled/lbw/caught/stumped/hit-wicket share of a bowler's wickets | **New columns** on `bowling_innings` (6 small INT counts) — batter side already has this, bowler side does not | +~5–8% on a 4.6 MB file | Only bowler-credited kinds count (bowled, lbw, caught, c&b, stumped, hit-wicket) per §4.1. | Natural complement to the batter breakdown; low weight. |
| E | **Innings-progression / acceleration splits** | First-10-balls SR, runs in balls 1–10 vs 11–20, "start-up cost" | **New columns** on `batting_innings` — per-ball sequence position within the batter's own innings, bucketed | +~10–15% on the 6.2 MB file | Needs a within-innings ball counter (derivable from `deliveries`, wides excluded from the count per batter-faced rule). Short innings have empty later buckets — expected. | The one genuinely new *analytical* batting axis. Cricket-meaningful (settling-in cost). |
| F | **Venue splits** | Avg first-innings score by ground; a batter's record at a venue | **New column** (venue key) on innings rows **or** a small venue-summary file — **plus a normalization decision (see Part 4)** | +small, but blocked on normalization | 884 distinct venue strings, but many are the **same ground under several names** ("R Premadasa Stadium, Colombo" / "R.Premadasa Stadium" / "Khettarama Stadium" are one ground; "Sheikh Zayed" = "Zayed Cricket Stadium"). `city` is null on 1,649 matches, and "County Ground" is reused across cities. | Analytically valuable but **not honest without normalization first**. Flagged as an owner question, not built blind. |
| G | **Maiden / spell-aware bowling** | Best spell figures, new-ball vs death spell economy, longest spell | Maidens **already** on `bowling_innings`. Spell figures = **new file** (spell grain), rebuildable from `deliveries` via the 3+-over-gap spell rule | New file, ~small | Spells are common: bowlers routinely bowl 2–4 spells/innings (96k innings with 2 spells, 65k with 3). Reference-doc spell-break rule is validated. | The maiden count is free today. Full spell figures are a nice-to-have, medium weight. |
| H | **Partnership-adjacent stats** | Runs added with each partner, partnership by wicket/position, run-out involvement | **New file** — `deliveries.non_striker_id` is 100% populated (0 nulls across 11.3M balls) | New file, medium | Attribution rule needs a ruling (see Part 4): who "owns" a partnership row, and how run-outs at the non-striker's end are handled. | Genuinely new and cricket-rich, but the highest-ambiguity item. |
| I | **Matchup: batter × bowling-style** | SR/average vs pace, vs off-spin, vs left-arm wrist-spin, etc. | **New file** (the D4.3 centerpiece) | New file, ~10–12 MB | Men-only; coverage 87–96% of men's balls (Part 2). Women 0%. | The headline new feature. See Part 2. |
| J | **Matchup: bowler × batting-hand** | Economy/strike-rate vs LHB vs RHB | **New file** (D4.3) | New file, ~5–6 MB | Men-only; 87–96% of men's balls carry a batting hand. | High value, cleanest coverage of any matchup. See Part 2. |

Families A, B, C are essentially **free** (data already exported) and I'd treat them as UI
work, not data work. D is a tiny addition. E, G, H, I, J are the real "new data" decisions.

Phase splits (powerplay / middle / death) are **already fully exported** for both T20 and
ODI over-ranges (`pp_*`/`mid_*`/`death_*` and `odi_pp_*`/`odi_mid_*`/`odi_death_*` columns
are present and populated on both innings files), so "phase" is not on the new-work menu.

---

## Part 2 — Matchup coverage (D4.3, the centerpiece)

Every matchup stat must carry a "based on N of M balls" denominator, and matchups only
work where the **other** player has a mapped style. The question is: what fraction of
balls qualify? Answer: **strong for men across every format; zero for women.**

### 2a. Batter × bowling-style — does the BOWLER have a mapped style?

% of legal-scope deliveries where the bowler has a mapped `bowling_group` (Pace/Spin) and
the finer `bowling_type`. (The two columns track within 0.1% of each other — mapping a
bowler's group almost always means we also know the type.)

**All-time:**

| Gender | Format | Balls | Bowler has group | Bowler has type |
|---|---|---:|---:|---:|
| Male | All T20 | 2,414,811 | 87.7% | 87.7% |
| Male | All ODI | 2,153,793 | 89.8% | 89.7% |
| Male | Test | 1,706,171 | 94.1% | 94.1% |
| Male | MDM | 3,713,893 | 93.4% | 93.4% |
| Female | All T20 | 798,056 | **0.0%** | 0.0% |
| Female | All ODI | 487,269 | **0.0%** | 0.0% |
| Female | Test | 45,046 | **0.0%** | 0.0% |

**Last 3 years (rolling):**

| Gender | Format | Balls | Bowler has group | Bowler has type |
|---|---|---:|---:|---:|
| Male | All T20 | 796,178 | 87.5% | 87.4% |
| Male | All ODI | 416,734 | 86.5% | 86.4% |
| Male | Test | 186,673 | 91.6% | 91.6% |
| Male | MDM | 1,124,822 | 90.1% | 90.1% |
| Female | (all) | — | **0.0%** | 0.0% |

### 2b. Bowler × batting-hand — does the BATTER have a mapped hand?

% of deliveries where the batter has a mapped `batting_style` (RHB/LHB).

| Gender | Format | All-time | Last 3y |
|---|---|---:|---:|
| Male | All T20 | 88.6% | 87.4% |
| Male | All ODI | 91.2% | 87.9% |
| Male | Test | 96.3% | 92.0% |
| Male | MDM | 92.6% | 89.3% |
| Female | any | **0.0%** | 0.0% |

**Reading of this:** for men, matchups are honest to ship in every format — roughly
**9 in 10 balls** carry the needed style on the opposing player, and the typical UI
denominator will read "based on ~88–94% of balls faced". Batting-hand coverage (2b) is
the single cleanest slice. **For women, matchups cannot be shown at all** — the profiles
sheet is men-only, so there is nothing to key off. The honest options for women are:
hide the matchup section entirely, or show it disabled with a "no style data" note (ties
directly to your deferred decision 8 on unknown-style display).

---

## Part 3 — Profile-powered filter readiness (D4.2)

For the four proposed Compare-Stats filters (playing-role, batting-hand, bowling-style,
teams-played-for), the question is how thin each filter's world is **within the universes
the site actually shows** (≥10 innings since 2023). "Has profile" is the ceiling; each
filter can only be as full as its field.

| Universe | Players | Has profile | role_group | batting_style | bowling_group | teams_played_for |
|---|---:|---:|---:|---:|---:|---:|
| Men T20 batters | 1,767 | 88.6% | **56.8%** | 87.4% | 72.0% | 88.6% |
| Men ODI batters | 626 | 88.8% | 85.3% | 88.5% | 73.8% | 88.8% |
| Men Test batters | 176 | 90.3% | 90.3% | 90.3% | 80.1% | 90.3% |
| Men T20 bowlers | 1,291 | 89.0% | **58.2%** | 87.7% | 86.4% | 89.0% |
| Men ODI bowlers | 424 | 89.6% | 86.8% | 89.2% | 89.6% | 89.6% |
| Women T20 batters | 902 | **0.0%** | 0.0% | 0.0% | 0.0% | 0.0% |
| Women ODI batters | 264 | **0.0%** | 0.0% | 0.0% | 0.0% | 0.0% |

**What this means per filter (men):**
- **Batting-hand** and **teams-played-for**: essentially as full as the match rate itself
  (~88–90%). Whenever we have a player, we have these. These two filters are ready.
- **Bowling-style**: strong for bowlers (86–90%) and Test/ODI batters; ~72–74% among the
  broad T20/ODI batter pools (many pure batters simply have no bowling style — that is
  correct, not missing data).
- **Playing-role**: the weak one. In domestic-heavy men's **T20 the role is known for only
  ~57%** of the qualifying pool, because many domestic players are matched but the sheet
  never classified their role. In ODI/Test it firms up to 85–90%. A role filter would
  leave roughly **half of the T20 world unfiltered/hidden**.
- **Women**: every profile-powered filter is empty. The filters must degrade honestly when
  gender = Women (hide the filter, or show it inert) — never silently return an empty table.

Per your D4.2 rule, when no profile filter is active, unmatched players still appear
normally; the thinness above only bites when a profile filter is switched on.

---

## Part 4 — Recommendation & owner questions

### Build first (high value, honest coverage, low weight)
1. **Matchup: bowler × batting-hand (J)** and **batter × bowling-style (I).** This is the
   headline feature and the coverage is genuinely good for men (87–96% of balls). Ship as
   two new per-innings-grain parquets so date/team/format filters keep working the same way
   they do today, always rendered with the "based on N of M balls" denominator. Men-only;
   the section hides for Women.
2. **Free splits already in the data (A batting-position, B opposition, C batter
   dismissal-type).** These need zero new data — only UI. Very high value-per-effort.
3. **Bowler wicket-type breakdown (D).** Six small integer columns on `bowling_innings`;
   makes the bowler side symmetric with the batter side. Trivial weight.

### Build second (new but well-defined)
4. **Innings-progression / acceleration (E).** The one genuinely new batting axis;
   derivable cleanly from `deliveries`. Medium weight; worth it.
5. **Maiden/spell-aware bowling (G).** Maidens are already free; the spell-figures file is
   a nice-to-have once the above land.

### Defer / needs a decision before it's worth the weight
6. **Venue splits (F)** — do **not** build until venue normalization is decided (below).
   Splitting on 884 raw strings would scatter one ground across several rows and mislead.
7. **Partnership stats (H)** — high ambiguity; build only after an attribution ruling.

### Owner questions (cricket/definition rulings I will not guess)
1. **Venue normalization.** The reference doc lists only a *team_registry* rename problem
   as a future to-do; there is **no venue registry**, yet the data has the same ground under
   multiple names (Premadasa/Khettarama; Sheikh Zayed/Zayed) and reuses generic names
   ("County Ground") across cities, with `city` null on 1,649 matches. Venue splits need a
   curated venue-normalization map first, exactly analogous to the team_registry gap. Do you
   want that built (manual mapping) before venue splits, or shipped raw with a caveat?
   *(Flagged, not resolved — this extends the reference doc's caveat rather than contradicting it.)*
2. **Team/franchise normalization for opposition splits and the teams-played-for filter.**
   Same rename issue (RCB Bangalore→Bengaluru, etc.). Opposition splits and the "teams
   played for" filter both fragment without it. Ship raw, or wait on a team_registry?
3. **Partnership attribution.** If we build partnership stats: does a partnership row belong
   to both batters (double-counted per player) or to the higher-order batter? And how are
   run-outs at the non-striker's end attributed? These are cricket-judgement calls.
4. **Unknown-style display (your deferred decision 8).** Matchups and the role filter both
   hit this: when a player has no mapped role/style, and for the entire women's game, do we
   **hide** the matchup/filter section or show it as **"–" / inert**? This decision gates
   how honestly the thin-coverage cases (esp. men's T20 role at 57%, and all of women's
   cricket) present.

### Not flagged as contradictions, but noted
- The reference doc header still says "17 tables / Phase 6 in progress"; the DB now has 17
  tables because this project added `player_profiles` (16 original + profiles), consistent
  with your decision 6. No action needed — just noting the doc predates the profile table.

---

## Appendix — implementation notes (technical; skip if non-coding)

- **DB used:** `.../scratchpad/d0_test/data/cricket.duckdb` (has `player_profiles`; repo
  `data/cricket.duckdb` does not). Opened `read_only=True`. Repro: `analysis/d4_explore.py`.
- **Matchup grain.** Per-innings × opposing-style keeps the existing filter-pushdown model:
  - `matchup_batting.parquet` grain `(match_id, innings_number, batter_id, bowling_type)` →
    **807,851 rows** (~2× `batting_innings`; ~10–12 MB zstd). Components per row: balls
    (wides excluded, no-balls faced), runs_batter, dots, fours/sixes hit, dismissals where
    `player_out_id = batter`. Browser rolls `bowling_type` up to `bowling_group` for the
    coarse pace/spin view; carry `bowling_group` too or derive it.
  - `matchup_bowling.parquet` grain `(match_id, innings_number, bowler_id, batting_style)` →
    ~397,320 rows (~5–6 MB). Components: legal balls (`wides IS NULL AND noballs IS NULL`),
    runs_conceded (`runs_batter + COALESCE(noballs,0)+COALESCE(wides,0)`), bowler-credited
    wickets via `wickets` join, dots, boundaries.
  - Both: join `deliveries` → `player_profiles` on the **opposing** player's id; exclude
    super-over innings (`innings.super_over IS NOT TRUE`); denominator M for the UI = the
    player's total balls in scope, N = balls where the opponent's style is mapped.
- **Free-split columns already present:** `batting_position`, `dismissal_kind`,
  `batting_team`/`bowling_team` on the innings files; `pp/mid/death` and `odi_pp/mid/death`
  phase columns on both. No export change needed for families A/B/C or phase metrics.
- **New small columns (family D):** `wickets_bowled/lbw/caught/caught_and_bowled/stumped/
  hit_wicket` on `bowling_innings`, from the `wickets` join, credited kinds only.
- **Family E:** add a within-innings faced-ball counter over `deliveries` (partition by
  `(match_id, innings_number, batter_id)`, order by over/ball, count only `wides IS NULL`),
  bucket into e.g. balls 1–10 / 11–20 / 21+, store `(runs, balls)` per bucket.
- All new files follow §4.2 conventions: sorted by `match_date` then `match_id`, row group
  ~100k, zstd, division-by-zero ratios computed client-side as NULL.
