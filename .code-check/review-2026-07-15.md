# cricdb — Codebase Health Report (Gate 1)

Date: 2026-07-15 · Branch: `polish-b1-mechanical` · First health review (no previous
report to compare against). Read-only — **nothing has been changed**.

How this was produced: five specialist read-only reviewers (two on the app's
number-producing code, one on the rest of the app's screens, one on the Python data
pipeline, one on the stylesheet) plus the orchestrator's own checks on folders,
documentation, dependencies, and secrets. Every finding cites the exact file and
line. Companion document: `review/FILE_SPLIT_PLAN.md` (the plan-only proposal for
splitting the five oversized files — nothing there is executed either).

---

## 1. Executive summary (plain language)

**Overall: this is a healthy codebase with a messy garage.** Nothing found anywhere
can produce a wrong cricket number today — five independent reviewers each came back
with **zero "blocker"-class findings**. The code that calculates and displays stats
is disciplined: every risky pattern we specifically hunted for (out-of-order query
results overwriting fresh ones, the special big-number format DuckDB returns,
user-typed text being injected into queries or into the page) is correctly handled.
The data pipeline's safety net (validation gates, upload ordering, alerts) is
genuinely strong and all of its previously-claimed protections were verified real.

The problems are hygiene, not danger. Roughly **500+ lines of provably dead code**
have accumulated across seven polish rounds — about 350 in the stylesheet alone
(entire old versions of the filter UI that were replaced but never deleted) and
~150 across the app's JavaScript (functions nothing calls any more). There are a
handful of efficiency warts — the worst being that clicking "Show More" on a big
table makes the browser re-measure the name column ~2,800 times in a row — and one
slow leak where redrawing the graph controls keeps stacking invisible listeners on
the page. On disk (not in git), ~2.1 GB of scratch files from the build can be
reclaimed. Two pipeline items are worth attention even though they're dormant: the
workflow currently uploads the database *before* running its correctness checks
(harmless only because DB uploads are still switched off), and two purely-advisory
reporting steps can kill a whole data refresh if the network hiccups for a second.

**If nothing is done:** the app keeps working exactly as it does now. The cost is
future-facing — every edit to these files is slower and riskier than it needs to
be, and the two pipeline items become real hazards the day `DB_UPLOAD_ENABLED` is
switched on. **Jargon used below:** "dead code" = code nothing can ever run;
"grep-proven" = we searched the entire project for anything that uses it and found
nothing; "latent" = a flaw that exists but hasn't fired.

---

## 2. Scorecard

| # | Dimension | Grade | One-line justification | Trend |
|---|---|---|---|---|
| 1 | Correctness risks | **4.5/5** | Zero blockers across five reviews; async/BigInt/escaping discipline verified everywhere; only latent, currently-dormant pipeline ordering issues | first review |
| 2 | Efficiency / performance | **4/5** | Sound overall; four concrete hot-path wastes (search scan, Show-More reflows, radar re-query, listener accumulation) | first review |
| 3 | Architecture & modularity | **3/5** | Clean module boundaries and one shared store — but five files far over the 600-line guideline, and graph.js is one 3,000-line tangle of shared state | first review |
| 4 | Readability & maintainability | **3.5/5** | Unusually well-commented; conventions consistent; dragged down by ~500 lines of dead code and heavy copy-paste in the metric catalogue | first review |
| 5 | Test coverage & quality | **2/5** | No automated test suite; partially redeemed by the pipeline's 21 validation gates + spot-checks and the standing-anchor discipline | first review |
| 6 | Security & data handling | **4.5/5** | Secrets never committed (verified against full git history); SQL quote-escaping and HTML escaping consistent; one cosmetic wildcard gap | first review |
| 7 | Dependency health | **4.5/5** | Five pinned Python deps, all actually used; JS libraries vendored with VERSION files; nothing unused or duplicated | first review |
| 8 | Docs & operability | **4/5** | README verified accurate (including pipeline description); SPEC + decision log current; no test/verification runbook (mitigated by anchor list) | first review |

## 3. Delta since last review

First review — no delta. This report is the baseline; the next run compares against it.

---

## 4. Findings

Severity: **BLOCKER** (wrong results/data loss possible) · **SHOULD-FIX** (real
cost, not urgent) · **NIT** (cosmetic). Each carries a cleanup-safety tag:
**SAFE** = provably zero behaviour change · **RISKY** = touches query/render logic,
needs anchor re-verification · **OWNER-DECISION** = fixing it would change something
visible or operational, so you decide explicitly.

### BLOCKER

**None.** All five reviewers independently reported zero findings in this class.

### SHOULD-FIX — App (JavaScript)

**A1. Dead code, grep-proven (bundle, ~150 lines).** All SAFE, minutes each:
- `src/graph/charts.js:121-134` — `formatMetricValue`, a dead sibling of the live
  formatter; invites future misuse.
- `src/graph/phaseFamilies.js:75-78` — `getPhaseFamily`, exported, zero callers.
- `src/graph/benchmark.js:193-195` + `graph.js:52,2449` — `benchmarkFloorNotes` is a
  stub that always returns nothing; the code that calls it can only ever take the
  "nothing" path (proven). Remove stub + simplify the caller to what it already does.
- `src/graph/card.js:346-348,508` — `isEdited` exposed on the card controller,
  never called.
- `src/advanced.js:105-159` — four dead exports (`describeAdvanced`, `condPhrase`,
  `opWord`, `addCondition`) plus the import only they used; superseded by
  state.js/pills.js.
- `src/table.js:27` — a re-export of `eligibleMetrics` nothing imports from here.
- `src/playerSections.js:426-441` — `overlayTokens`, exported, unused (self-documented
  as kept-for-future; recommend removing — git history keeps it).
- `src/playerSections.js:469` + `playerPage.js:342` — `scopeLine`'s `fixedDefault`
  parameter is never read; drop it and the call-site argument.
- Over-exports (drop the `export` keyword only): `charts.js:568` `shortenName`,
  `card.js:113/215/220` `autoTitle`/`autoSubtitle`/`eyebrowFor`, `metrics.js:1603`
  `METRICS`.

**A2. `src/graph/graph.js:1228,1535` (helper at 238-260) — graph dropdowns leak
page-level listeners.** Every redraw of the graph's metric controls permanently adds
two more invisible click/key listeners to the page (each holding a dead copy of the
old controls in memory). Functionally invisible; on a long session it's real memory
and event overhead. Fix: make the dropdown helper return a cleanup function, call it
before each redraw. Effort: ~1 hour. **RISKY** (event wiring — needs a hands-on
click-through of open/close/Escape/outside-click, not number checks).

**A3. `src/table.js:751-760,1679-1683` — "Show More" jank.** The sticky name column
is sized by measuring every visible row one at a time, forcing a browser layout pass
per row; "Show More" makes that ~2,800 consecutive layout passes. Fix: pre-pick the
longest name(s) by string length and measure only those. Effort: ~30 min. **RISKY**
(visual dimension only — no numbers; verify the column width looks identical).

**A4. `src/playerData.js:196-200` — player-search does needless whole-table work per
keystroke.** The "latest name" step scans the entire player-matches table on every
search, even though it only needs the handful of matched players (the sibling step
directly above it already restricts correctly). Fix: one WHERE clause, same shape as
the sibling. Effort: minutes. **RISKY** (query text changes; result provably
identical — spot-check the search dropdown afterwards).

**A5. `src/table.js:335,603,684` + `src/graph/players.js:185` — table/graph name
search treats `%` and `_` as secret wildcards.** Typing `%` in the table's search
box over-matches rows. The player-search in playerData.js already escapes these
correctly; these four sites don't. No injection risk (quotes are escaped). Fixing it
is a no-op for every normal search — it changes results **only** when someone types
`%` or `_`. **OWNER-DECISION** (it visibly changes that one edge case — recommend
fixing for consistency). Effort: ~15 min.

**A6. `styles.css` — used-but-undefined variable `--color-text` (lines 2709, 2724).**
Two graph-rules text styles reference a colour variable that doesn't exist; they
look right today only by accident of inheritance. Fix: point them at the intended
`--color-fg`. **OWNER-DECISION** (could shift the colour of two captions by a
shade — verify by eye in light + dark mode). Effort: minutes.

### SHOULD-FIX — Stylesheet (dead CSS, ~350+ lines)

**A7. Entire superseded UI systems still styled.** All **PROVEN-DEAD** (the auditor
verified this codebase never builds class names dynamically, so a full-project
search is conclusive; each dead block was also traced to the live system that
replaced it). All SAFE:
- `styles.css:855-986` — the OLD "Advanced filters" block (~132 lines; replaced by
  the condition builder).
- `styles.css:668-730` — the old F1b "Player section compact layout" (~63 lines;
  replaced by the player-popup drawer).
- `styles.css:1964-2063` (most of) — the old right-side "All filters" drawer
  (replaced by the Filters popup; two selectors in this region ARE still live —
  `.drawer__close`, `.filter-drawer__footer` — the audit lists exactly which).
- `styles.css:1815-1822, 2195-2200, 2137, 2255` — the old on-page "All filters"
  button.
- Smaller: `.filter-bar--profile`/`.filter-group--profile-head` (648-654),
  `.pills-section` rules (1847, 1863), `.filter-section` (387-392, 2311),
  `.cond-builder__add` (1045), plus three dead *tokens* inside shared live rules
  (`.filter-drawer`, `.filter-drawer__backdrop`, `.status-text`) which need a
  surgical selector-list edit, not block deletion.
- `--color-good` (46, 106) — defined, never used.
Effort: ~1-2 hours total including a careful visual pass. **SAFE** (with the visual
pass as the proof).

### SHOULD-FIX — Data pipeline (Python) — all changes here are test-first

**P1. `.github/workflows/pipeline.yml:111-127` — the database upload runs BEFORE the
correctness gates.** The workflow pushes the freshly-ingested database to the cloud
in step 9, and only in step 10 runs the 21 validation gates. A bad ingest would be
uploaded before validation caught it. **Currently harmless** — the upload is
switched off by the `DB_UPLOAD_ENABLED` latch — but it becomes the single most
dangerous line in the project the day that latch flips. Fix: move the upload step
after the export/gates step. Effort: minutes. **OWNER-DECISION** (it reorders the
production workflow, and you own the latch plan).

**P2. `pipeline/check_ingest.py:77,146` + `pipeline/report_new_unmatched.py:111,192`
— advisory steps can kill the whole data refresh.** These two steps only produce
health reports, but a one-second cloud-storage hiccup inside them crashes the run
before the export step — the site silently stops getting fresh data until the next
run. A third sibling script already guards against exactly this. Fix: same guard in
these two. Effort: minutes. **SAFE** (purely additive error handling).

**P3. `pipeline/ingest.py:52-68,1003-1012` — corrected match files from Cricsheet are
never re-ingested.** The source occasionally re-publishes a fixed match file under
the same name; the pipeline permanently ignores anything it has seen before, so
upstream corrections never arrive. Genuine but low-frequency. Fixing means keying on
file content, not name, and re-ingesting changed files. **OWNER-DECISION** (numbers
would change — toward *corrected* upstream data — and it touches the ingest write
path; recommend treating as its own small project later, not part of this cleanup).
Effort: hours, test-first.

**P4. `pipeline/ingest.py:896,924,939,950` — one class of "unknown player" problem
alerts opaquely.** If a player id ever failed to resolve at the ball-by-ball level,
the run fails safe (a validation gate trips) but you'd get a cryptic "VALIDATION
FAILED" instead of the plain-English "player X missing in file Y" alert the squad
path already produces. Zero occurrences in the real data to date. Fix: extend the
existing alert capture to these lookups (logging only, no change to what's stored).
Effort: ~1-2 hours. **SAFE** if purely additive.

**P5. `pipeline/dev_test_matchup_extension.py` (1,055 lines) — stale scaffolding.**
Not wired into CI, hard-codes a path that only exists on this Mac, imports a stale
scratchpad file, and everything it validates is now merged into export_parquet.py
and covered by the export gates. Fix: delete (git history preserves it). Effort:
minutes. **SAFE** (grep-proven unwired).

### NIT (10 most representative — complete list in the appendix)

1. `pipeline/ingest.py:55-58` — a "stream the download" flag that doesn't actually
   stream (whole file lands in memory anyway). SAFE.
2. `pipeline/build_profiles.py:671-757` — table rebuild isn't wrapped in a
   transaction; fails safe today (export refuses to run without the table). SAFE.
3. `src/table.js:81-103` — the query-state serializer omits the event/venue filters;
   currently inert (never compared), a trap if ever reused. SAFE, 2 min.
4. `src/graph/graph.js:2892-2925` — the radar chart re-fetches its comparison pool
   on every redraw; the benchmark chart next to it caches the identical fetch. RISKY.
5. `src/graph/graph.js:1867-1888` — chart-type availability recomputes the same
   metric list up to 6× per pass on a hot path. RISKY (verify greyed tiles).
6. `src/graph/graph.js:817-855` — slope and dumbbell window defaults are the same
   logic written twice; extractable into one helper. SAFE.
7. Duplication cluster (consolidate only if the split plan proceeds): the pace/spin
   bowling-type ordering exists in 3 hand-synced copies (`table.js:109`,
   `drawer.js:63`, `playerSections.js:270`); month-options HTML ×2; positions label
   ×2; state.js/pills.js condition-label near-dupes (deliberate, avoids an import
   cycle); the metric `<select>` block ~7× in graph.js; the include/exclude row
   split ~6× across chart renderers; Chart.js options scaffolding ×6.
8. `styles.css` backdrop rule duplicated 3× verbatim (4079-4086, 4273-4280 vs the
   already-merged 1952-1961). SAFE merge.
9. `src/playerFilters.js:244-245` — a month-vs-day format mismatch makes one
   "did anything change?" check always say yes; benign. SAFE.
10. `secrets.md` — real credentials in a plaintext file on disk. Correctly
    gitignored and **never committed** (verified against full history); fine for a
    personal machine, but consider a password manager, and rotate the GitHub token
    if this laptop is ever shared/lost.

---

## 5. Proposed fix-batch plan (Gates 2…N — nothing starts without your go)

Each batch: small, committed on its own, verified (`node --check`, boot on
localhost:8000 with zero console errors, standing anchors re-checked on-screen —
plus an independent DuckDB query whenever query text changed), then **STOP for your
approval** before the next.

| Batch | Contents | Risk | Agent roster (model/effort) |
|---|---|---|---|
| **1. Dead code** | A1 (JS dead code) + A7 (dead CSS) + P5 (stale dev-test file) | Lowest — all grep-proven | frontend-engineer **Sonnet/high** (JS) ‖ design-stylist **Sonnet/high** (CSS) — disjoint files, can run together |
| **2. Duplication** | NIT 6 (window-defaults helper), NIT 8 (backdrop merge), + only if you want them: bowling-type/month-options consolidation | Low | frontend-engineer **Sonnet/high** |
| **3. Efficiency** | A4 (search scan), A3 (Show-More measuring), A2 (dropdown listener leak), NIT 4-5 (radar cache, availability hoist) | Medium — anchor + hands-on checks | frontend-engineer **Sonnet/high**, orchestrator (Fable) verifies anchors independently |
| **4. Latent-bug fixes** | NIT 3 (serializer fields), NIT 9 (month/day compare) + the two you decide: A5 (wildcard escaping), A6 (`--color-text`) | Low-medium | frontend-engineer **Sonnet/high** |
| **5. Stale-folder prune** | Exactly the list you approve below | Low (git history + your call) | orchestrator inline (no agent needed) |
| **6. Pipeline (test-first)** | P2 (advisory guards), P4 (plain-English alerts), NITs 1-2 + P1 if you approve the reorder | Medium — data-critical, so slowest and last | data-engineer **Opus/high**, solo, one change at a time |

Deliberately **excluded** from this cleanup (each would be its own decision):
P3 (Cricsheet corrections re-ingest — changes numbers toward corrected data),
the metrics-catalogue generator (E-item in the split plan), any file splitting
(see `review/FILE_SPLIT_PLAN.md`), and a focus-trap/accessibility pass on the
popups (behaviour-adding).

## 6. Stale-folder prune list (PROPOSAL — nothing deleted until you confirm)

| Folder / file | Size | In git? | Recommendation | Why |
|---|---|---|---|---|
| `scratchpad/` | **1.1 GB** | no (ignored) | **Delete from disk** | Build-era scratch parquets + the stale `export_parquet_OLD.py`; nothing references it except one historical comment |
| `data/` | 1.0 GB | no (ignored) | **KEEP** | Your local database + export output — needed for any local pipeline run |
| `v1_reference/` | 256 KB | no | **Delete from disk** | Old repo's UI reference; design already absorbed |
| `__pycache__/` | 96 KB | no (ignored) | **Delete from disk** | Python cache; regenerates itself |
| `v1_pipeline/` | 52 KB | **yes (3 files)** | **Remove from repo** | The old scripts were ported into `pipeline/` long ago; only historical SPEC text mentions them |
| `pipeline/dev_test_matchup_extension.py` | — | **yes** | **Remove from repo** (= P5) | Stale, machine-specific, superseded by export gates |
| `analysis/` | 72 KB | **yes (6 files)** | **Remove from repo** (or keep `D4_PROPOSAL.md` if you want the history handy) | One-off exploration scripts + vocab CSVs; nothing in the app or pipeline reads them |
| `image_inspiration/` | 308 KB | yes (1 file) | **Remove from repo** | One design-inspiration screenshot, absorbed |
| `reference/` | 60 KB | yes (2 files) | **KEEP** | Your validated DB reference doc + chart-system doc — living documentation |
| `debug/` | 16 KB | yes | **KEEP** | The SQL debug console — a working tool, referenced by the README |
| `source_data/` | 16 MB | yes (1 file) | **KEEP** | The Cricinfo profiles CSV — read by the live pipeline |
| `vendor/` | 72 MB | yes | **KEEP** | The app's actual libraries (DuckDB-WASM, Chart.js, html2canvas, fonts — all verified in use) |
| `secrets.md` | — | no (ignored) | **KEEP** (see NIT 10) | Your credentials file; never committed |

Net effect if you approve all deletions: **~1.1 GB reclaimed on disk**, and the git
repo loses ~11 tracked files nothing uses. Everything deleted from the repo remains
recoverable from git history forever.

## 7. Priority actions (top 5, by value-for-effort)

1. **Approve Batch 1 (dead code + dead CSS + stale dev-test).** ~500+ lines gone,
   zero behavioural risk, and it makes every later batch's diffs cleaner.
2. **Fix the player-search whole-table scan** (A4) — a one-line query restriction
   that removes the app's most-repeated wasted work.
3. **Bound the Show-More measuring loop** (A3) — the one finding a user can feel.
4. **Add the pipeline availability guards** (P2) — two tiny additive guards so a
   network blip in a report step can't stop your data refreshing.
5. **Decide P1 (upload-before-gates reorder) now, while it's dormant** — a
   minutes-long workflow edit that removes the worst latent hazard before the
   `DB_UPLOAD_ENABLED` latch ever flips.

## 8. Fix-run kickoff prompt (ready to paste, if/when you approve)

> Execute the approved cleanup batches from `review/CODEBASE_HEALTH_REPORT.md`
> (sections 4-5) on branch `polish-b1-mechanical` in repo
> `/Users/tarutr/Desktop/live_db`. `main` is production — never touch it.
> Batch order: 1 dead code (report items A1, A7, P5) → 2 duplication (NITs 6, 8) →
> 3 efficiency (A4, A3, A2, NITs 4-5) → 4 latent bugs (NITs 3, 9 [+ A5/A6 if
> approved]) → 5 folder prune (only the owner-approved list in section 6) →
> 6 pipeline, test-first (P2, P4, NITs 1-2 [+ P1 if approved]).
> After EVERY batch: `node --check` each touched .js file; serve with
> `python3 -m http.server 8000`; boot with zero console errors; re-verify the
> standing anchors (Men/T20/International, dates 2023-07-01→2026-07-02: batting
> 2,813, bowling 2,049; SA Yadav 60/1,544/29.13/150.34, vs Spin 38/454/140.99,
> coverage 913 of 1,027; Bumrah vs RHB pos 1-2: 27/177/9; header-search popup
> SA Yadav 205/6,345/36.05/159.90) — independently via a direct DuckDB console
> query wherever query text changed (SUMs come back as BigInt → Number() first);
> checkpoint-commit; STOP for the owner's go. If ANY anchor moves, revert the
> batch. Browser caches ES modules: fetch(path,{cache:'reload'}) changed files,
> then reload, before verifying.

## 9. Coverage disclosure

**Read in full by a reviewer:** all 30 modules under `src/` and `src/graph/`
(~17,600 lines); `styles.css` (audited selector-by-selector, 363 class tokens);
`index.html`; `export_parquet.py` and all 11 `pipeline/*.py` files;
`.github/workflows/pipeline.yml`; `requirements.txt`; `README.md`. Dead-code claims
were verified by searching the entire project for references, and the CSS auditor
first proved the codebase never constructs class names dynamically (making its
"dead" verdicts conclusive rather than probabilistic).

**Sampled / lighter coverage:** `debug/index.html` (greps only); the stale-candidate
folders (inventoried and reference-checked, contents not code-reviewed — they're
prune candidates, not live code); `SPEC.md`/`SPEC_ADDENDUM_DATA.md` (consulted, not
audited); vendored third-party libraries (out of scope — verified present, versioned,
and referenced, not reviewed line-by-line).

**Not done:** no runtime profiling (efficiency findings are from reading, not
measuring); no penetration testing (the security dimension is a hygiene check);
the pipeline was reviewed statically, not executed — the pipeline reviewer's
local-run safety notes (which scripts are safe to run for verification) are
preserved for Batch 6: `export_parquet.py` with `--db <copy> --out <tmpdir>` and
no upload/download flags is fully local and is the sanctioned verification path;
`upload_db.py` and `--upload` must never be run locally.

## 10. Appendix — complete nit list (one line each)

1. `pipeline/ingest.py:55-58` — `stream=True` then `.content` defeats streaming; drop the flag or stream to disk.
2. `pipeline/build_profiles.py:671-757` — wrap DROP+CREATE of player_profiles in a transaction.
3. `.github/workflows/pipeline.yml:129-135` — profiles-fallback "fail" step runs after publish; red flag prevents nothing (works as signal; leave or reorder consciously).
4. `pipeline/ingest.py:538-714` — `innings_batters`/`innings_bowlers`/`bowling_spells` built but unread by export; likely legacy-DB consumers — observation only, do NOT remove without owner confirming no other consumer.
5. `src/table.js:81-103` — `serializeQueryState` omits event/venue; add fields or comment.
6. `src/table.js:1237-1243` — `coverageLabel` skips the defensive `Number()` its sibling `matchupCoverageLine` uses; harmless, align for consistency.
7. `src/playerFilters.js:244-245` — month-vs-day compare means the no-op check never fires; normalize to YYYY-MM.
8. `src/graph/graph.js:817-855` — slope/dumbbell window-default logic duplicated; extract one helper.
9. `src/graph/graph.js:1867-1888` — hoist `eligibleMetrics` once per `syncChartTypeButtons` call.
10. `src/graph/graph.js:2892-2925` — radar pool fetch should reuse the benchmark pool cache.
11. `src/graph/graph.js:1072-1384` — single-metric `<select>` block repeated ~7×; one factory (careful: deliberate per-type differences).
12. `charts.js` + `dumbbellChart.js` — include/exclude row partition copy-pasted 6×; shared helper with per-chart predicate.
13. `charts.js`/`timeseriesChart.js`/`dumbbellChart.js` — Chart.js options scaffolding duplicated ~6×; `baseChartOptions(pal)` factory (visual-regression care).
14. `table.js:109` / `drawer.js:63` / `playerSections.js:270` — pace/spin taxonomy in 3 hand-synced copies.
15. `filters.js` / `playerSections.js:45` — `monthOptionsHTML` ×2.
16. `drawerInnings.js:47` / `playerFilters.js:165` — `positionsSummaryLabel` near-identical ×2.
17. `drawerInnings.js:219` / `playerFilters.js:42` — two different functions share the name `fetchOppositionOptions`; rename one.
18. `state.js:222-240` / `pills.js` — condition-label near-dupes kept to avoid an import cycle; a shared leaf module would fix it properly.
19. `playerData.js:97-107` / `filters.js` — month-upper-bound date arithmetic written twice; shared helper (RISKY: date SQL).
20. `playerData.js:267` — `relevanceOrderBy` lacks the wildcard-escape its sibling has; ordering-only effect (ties into A5).
21. `styles.css:4079-4086, 4273-4280` — backdrop rule duplicated verbatim; join the existing merged selector list.
22. `styles.css` — `min-height: 40px` tap-target repeated as a literal in 9+ rules; one `--tap-target-min` token.
23. `styles.css:46,106` — `--color-good` defined, never consumed (ties into A7).
24. `styles.css` grid `2082-2290` — mobile grid still names an `"allfilters"` area no element occupies; harmless, tidy when touching that grid.
25. `secrets.md` — plaintext credentials on disk (gitignored, never committed); consider a password manager / rotate PAT on any exposure.
26. `.DS_Store` files present (gitignored) — cosmetic.
27. `src/graph/graph.js:1977` + `index.html:24` — neither popup traps keyboard focus (consistent posture, accessibility gap; behaviour-adding = owner call).
28. `metrics.js:88-1601` — ~1,200 lines of near-identical metric objects ×4 arrays; the opt-in generator project (test-first, snapshot byte-identical).
29. `charts.js:337` — comment references a `history/v1_reference/...` path that never existed in this repo; fix comment when touching the file.
30. `index.html:10` — Chart.js loads on every page view though only Graphs uses it (it IS deferred; lazy-load-on-tab is possible but changes load timing — owner call, low value).
