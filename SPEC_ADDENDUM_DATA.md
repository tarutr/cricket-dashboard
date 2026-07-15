# SPEC ADDENDUM — Data Expansion & Pipeline Ownership (Phases D0–D5)

> **PROGRESS (2026-07-08).** D0 ✅ (pipeline ownership migrated, this repo owns
> cricket.duckdb on R2, runs every 6h). D1 ✅ (matching analysis). D2 ✅ (player_profiles
> built + enriched taxonomy, live). D3 ✅ (Dropbox resilience + alert emails, gate passed).
> Review workflow ✅ (two-sheet, `review/PLAYER_REVIEW.md`). **D4: data layer ✅ done +
> deployed + verified. D4 FRONTEND in progress (5-piece plan in
> `review/D4_FRONTEND_PLAN.md`): Piece 1 (profile filters) ✅ owner-approved,
> Piece 2 (wicket-type + progression-SR metrics) ✅ built + verified; Pieces 3–5
> (free splits, batting matchup, bowling matchup + polish) remain.** D5 (profile
> pop-ups) and original Phase 4 (polish) follow. All owner rulings are recorded in
> `review/owner_decisions.md` (authoritative).

Read together with SPEC.md. SPEC.md's rules §8 (non-negotiables), §4.1 (calculation
rules), and its ask-don't-assume working style apply here unchanged. These phases run
AFTER Phase 3 (graph builder, done) and BEFORE the original Phase 4 (polish), which
becomes the final phase. Each phase ends at an acceptance gate: STOP, show the owner
results in plain English, and wait for approval.

## Strategic decision (owner-confirmed)

This project (`cricket-dashboard`) becomes the PRIMARY and ONLY owner of
`cricket.duckdb` on Cloudflare R2. The old wt20-guide project is being sunset: its
data pipeline will be switched off and its site left frozen at its last data. All
database maintenance must be fully automated in this repo's GitHub Actions — the
owner's desktop copy is a build-time test artifact only, and nothing in production
may ever depend on the owner running something manually.

## New inputs

- `source_data/cricinfo_player_profiles.*` — local copy of the Cricinfo player
  profiles sheet. Fields of interest (confirm exact column names by inspection,
  never assume): full name, batting name (maps to database registry names), country,
  batting style/hand, bowling style, playing role/position, teams played for,
  headshot_url (player image), DOB, and per-player career stats. Other fields exist;
  ignore unless the owner says otherwise.
- `DROPBOX_FOLDER_URL` in secrets.md — shared Dropbox folder containing the live
  sheet (and other future data). Direct-download form: replace `dl=0` with `dl=1`.
- `reference/db_reference.md` — the owner's validated database reference document.
  Its validated facts and calculation rules are authoritative.
- `v1_pipeline/` — held copies of the old repo's ingestion scripts (ingest.py,
  download_db.py, upload_db.py) for migration in D0. Ported into `pipeline/` and
  removed 2026-07-16; the originals remain in git history if ever needed.

## Phase D0 — Pipeline ownership migration

Goal: move Cricsheet ingestion into this repo, then decommission the old pipeline.

1. Port `ingest.py`, `download_db.py`, `upload_db.py` from v1_pipeline/ into this
   repo's `pipeline/` directory. *(Done; v1_pipeline/ since removed — see the
   inventory note above.)* Preserve ingestion logic EXACTLY — it is validated
   and battle-tested (incremental, per-file transactions). No "improvements" to
   ingestion logic without flagging to the owner first. Modernize only paths/wiring.
2. New single workflow `pipeline.yml` (daily cron + manual dispatch) replacing the
   current export-only workflow, running as one sequential chain:
   a. download cricket.duckdb from R2
   b. download + ingest new Cricsheet files (incremental)
   c. fetch profiles sheet from Dropbox (see D3 rules; from D2 onward)
   d. rebuild `player_profiles` table inside cricket.duckdb (from D2 onward)
   e. upload cricket.duckdb back to R2
   f. run export_parquet.py → upload all Parquet exports + manifest.json
   Each step logs clearly; any step failure fails the whole run visibly (red X +
   GitHub email to owner). A failed run must never upload a partially-built DB:
   upload happens only after ingest + profiles both succeed.
3. Concurrency guard: the workflow uses GitHub Actions `concurrency` so two runs can
   never overlap and clobber each other's DB upload.
4. Decommission the old pipeline: give the owner exact click-by-click instructions
   to disable the wt20-guide repo's update workflow in the GitHub UI (Actions tab →
   select workflow → "···" → Disable workflow). Verify with the owner it shows as
   disabled BEFORE this repo's pipeline.yml is allowed to write to R2. Until that
   moment, this repo's workflow must remain read-only against cricket.duckdb.
5. Acceptance: one full green pipeline.yml run; manifest timestamps advance; owner
   confirms old workflow disabled; spot-check that a recent real-world match appears
   in the data after the run.

## Phase D1 — Explore & report (no code changes to the site)

1. Inspect the profiles sheet: columns, types, row count, null rates per field of
   interest, distinct values for role/batting style/bowling style (these become
   filter vocabularies later — list them verbatim for owner review).
2. Coverage analysis both directions:
   a. What % of the database's ACTIVE player_ids (players with ≥1 delivery) have a
      confident match in the sheet — overall, by gender, by team_type, and by
      recency (active since 2023 vs earlier).
   b. How many sheet players have no database presence (expected: many — fine).
3. Matching strategy proposal: exact match on batting name + country first, then
   normalized/fuzzy tiers; define what evidence each tier requires. Produce a sample
   of 20 fuzzy matches for the owner to eyeball.
4. Deliverable: plain-English report (coverage numbers, match-tier table, problem
   patterns) + `review/unmatched_active_players.csv` and
   `review/ambiguous_matches.csv`. STOP for owner review and manual resolutions.

## Phase D2 — Enriched player registry

1. Build `player_profiles` — one row per matched database player_id:
   player_id, registry_name, full_name, country, dob, playing_role (verbatim +
   a normalized role_group the owner approves), batting_style, bowling_style
   (verbatim + normalized pace/spin group), teams_played_for (list), headshot_url,
   plus career stat fields (kept clearly separate, prefixed `career_`).
2. Manual resolutions from D1 live in `review/manual_matches.csv` (player_id ↔ sheet
   row), committed to the repo; every automated rebuild applies this file last so
   owner decisions persist across runs and sheet updates forever.
3. Unmatched active players remain on the site with no profile — never dropped.
   Sheet players with no database data are EXCLUDED from all site outputs (not
   searchable), per owner constraint.
4. Outputs: (a) `player_profiles` table in cricket.duckdb, rebuilt by pipeline.yml
   step (d) — a new table only; the 17 original tables are never modified, and the
   rebuild is preceded by a sanity check (all 17 tables present, spot row counts);
   (b) `player_profiles.parquet` in the explorer exports for the site.
5. Acceptance: owner reviews a rendered sample of 15 enriched profiles (names,
   roles, images loading) + final match-rate numbers.

## Phase D3 — Dropbox automation, alerting, and fallback

Design principle: the Dropbox sheet is an ENRICHMENT source that is copied into our
systems on every run — a broken or stale link must never break the site, and must
never fail silently. The owner is notified specifically; the site degrades honestly;
everything self-heals when the source recovers.

1. **Fetch + last-good-copy.** pipeline.yml step (c) fetches the profiles sheet from
   the Dropbox direct-download URL on every run. Each successful fetch is persisted
   as the "last good copy" (stored on R2 alongside the exports, with its fetch
   timestamp). The committed source_data/ file is only the initial seed.
2. **Manifest truth.** manifest.json gains `profiles_updated_at` (timestamp of last
   successful fetch), `profiles_content_changed_at` (last time the sheet's content
   actually changed — detected by hash), and `profiles_source`
   (dropbox | last-good-copy).
3. **Alerting — two conditions, both emailed to ALERT_EMAIL.** Reuse the v1 Gmail
   alert pattern (see export_feedback.py in the old project; secrets GMAIL_ADDRESS,
   GMAIL_APP_PASSWORD, ALERT_EMAIL — values in secrets.md, to be added to this
   repo's GitHub Actions secrets; walk the owner through that step click-by-click
   when it arrives):
   a. FETCH FAILURE: Dropbox unreachable / link dead / file missing → pipeline
      continues on last good copy, marks manifest, sends a specific email ("Dropbox
      fetch failed — using copy from [date] — check the share link") AND fails the
      Actions run so GitHub's own notification also fires.
   b. SILENT STALENESS: fetch succeeds but content hash unchanged for more than
      STALE_DAYS (default 21, configurable) → send a once-per-condition advisory
      email ("Sheet hasn't changed in N days — is the source still being updated?")
      without failing the run. Do not re-email daily; alert once, then again weekly
      while the condition persists.
4. **Career-stat fallback — QUIET, backend-only (owner directive).** Build a
   Cricsheet-derived career aggregate for every player (all data in our database,
   career-to-date — refreshed by our own ingestion forever, independent of Dropbox).
   The site's career displays follow this rule:
   - profiles fresh (profiles_updated_at within 14 days): serve the Cricinfo career
     figures.
   - profiles stale/failed: serve the Cricsheet-derived figures instead.
   The swap is invisible to site users: NO banners, NO source labels, NO disclaimers
   on profiles or anywhere else on the site. Which source served the data is
   recorded in manifest.json and pipeline logs only, and the owner is informed via
   the alert emails in D3.3. The two sources are never mixed within a single
   player's displayed career block in one build.
5. New/changed players arriving via Dropbox flow through the same match tiers; new
   ambiguous cases append to a review file in the repo — they never auto-match below
   the confident tier. The pipeline summary lists any new unmatched actives so the
   owner can resolve them at leisure.
6. Structure the Dropbox fetch + alerting as small reusable modules — the owner
   intends to add more sheets from this folder later, and every future sheet gets
   the same last-good-copy + alerting treatment for free.
7. Acceptance: (a) owner edits one cell in the Dropbox sheet, triggers the workflow,
   sees the change live; (b) a simulated fetch failure (temporarily wrong URL in a
   test run) produces the alert email and a working site on fallback, verified
   end-to-end before the phase closes.

## Phase D4 — Metric & filter expansion

1. **Database exploration step first** (report before build): read
   reference/db_reference.md + inspect cricket.duckdb; propose a candidate list of
   new metrics/components not yet exported (e.g. batting-position splits,
   dismissal-type breakdowns, innings-progression splits, venue splits, opposition
   splits, maiden/spell-aware bowling stats, partnership-adjacent stats). Present as
   a table: metric, what it needs in the parquet layer, coverage caveats. Owner
   picks; STOP before building.
2. **Profile-powered filters**: playing-role filter, batting-hand filter,
   bowling-style filter, and "teams played for" filter in Compare Stats — each
   filter option shows only values with matched players; filter results exclude
   unmatched players ONLY when a profile-based filter is actively applied
   (otherwise unmatched players appear as normal).
3. **Matchup aggregates** — new parquet(s) built from deliveries:
   a. batter × bowling-style components (runs, balls, dismissals, dots, boundaries
      per style faced) → "performance vs pace / left-arm spin / etc."
   b. bowler × batting-hand components → "bowler vs LHB/RHB".
   Both cover only deliveries where the OTHER player has a mapped style. Every
   matchup stat in the UI must carry a coverage denominator ("based on N of M
   balls, X%"), per the reference doc's partial-coverage rule. No coverage figure,
   no stat shown.
4. **Career compare mode**: a separate, clearly-labeled mode/tab — career figures
   are never mixed into the regular filtered-period Compare Stats tables or charts
   (owner constraint: Cricsheet period data and career data are different things).
   Which career source is served follows D3.4's quiet backend rule; no source
   labeling in the UI.
5. All new metrics go through the single metrics.js module; matchup and career
   metrics get their own namespaces there. hasMetricData applies everywhere.
6. Acceptance: owner review of each new comparison type with spot-checked numbers.

## Phase D5 — Profile pop-ups

1. Pop-up/overlay pattern modeled on the v1 dashboard's player popups
   (v1_reference/index.html shows the interaction style; adapt the design, don't
   copy code).
2. Player popup: headshot, full name, country, role, styles, teams, DOB/age, career
   stats block (served per D3.4's quiet backend rule, no source labeling), and a
   compact Cricsheet-data summary under the
   currently active filters. Opens from any player name in tables or charts.
3. Team popup: squad list (matched players) + basic team record under current
   filters. Venue popup: matches hosted + scoring-environment basics (avg
   first-innings score etc.). Team/venue popups use Cricsheet data only.
4. Players without profiles get a reduced popup (name + Cricsheet summary), never a
   broken one. Missing images get a neutral placeholder, never a broken-image icon.
5. Acceptance: owner clicks through 10 players across genders, 3 teams, 3 venues.

## Phase order from here

D0 → D1 → D2 → D3 → D4 → D5 → Phase 4 (original polish, now including the design
pass). Do not start a phase before the previous gate is approved by the owner.
D1 may run in parallel with D0 (it's read-only analysis) if convenient, but nothing
from D2 onward starts before D0's gate is approved.
