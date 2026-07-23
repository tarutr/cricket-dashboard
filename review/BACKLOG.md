# cricdb — deferred backlog (owner-prioritised; NOT built)

Contract: see `CLAUDE.md` (numbers-sacred rule, Rule 1); anchor baselines in `SPEC.md`. Decisions log: `review/owner_decisions.md`.

---

## Standing anchor scope
Men / T20 International, **2023-07-01 → 2026-07-02**:
- **Batting baseline:** 2,813 players; Karanbir Singh (top row) **2,454 runs**
- **SA Yadav anchor:** 60 innings / 1,544 runs / 29.13 avg / 150.34 SR
- **Bumrah vs RHB (pos 1–2):** 27 innings / 177 balls / 9 wickets
- **SA Yadav vs Spin:** 38 innings / 454 runs / SR 140.99 (coverage 913 of 1,027 balls)

---

## 1. Auto-add vs Keep-Columns — **DONE** (no change needed)
[data] / [app] · Already implemented as additive; user-controlled via "Keep Selected Columns" checkbox.

## 2. Docs sync — **IN PROGRESS** (this session)
[docs] · `reference/CHART_SYSTEM.md` (chart system overhaul), `review/BACKLOG.md` (this list), owner_decisions log.

## 3. Phase-component columns — **pending owner priority**
[data] · Add `pp_dots`, `pp_fours`, `pp_sixes`, `pp_dismissals` (+ mid/death/odi variants) to the pipeline
so by-phase Dot% / Boundary% / Fours / Sixes / Batting Average / dismissal-types become chartable. Owner to
confirm priority vs per-over.

## 4. Column-group dropdown metrics — **pending build spec**
[app] · Define which metrics belong to Core/Boundaries/Dismissals/Phases/Progression presets, made
format-sensitive AND multi-format-sensitive (T20/50-Over/Red Ball mix handling). Needs a detailed spec
before build.

## 5. First-name player search — **pending owner build**
[data] · Curated common-name map. **Owner note:** owner has a player registry built in a separate project
and will add those files to the folder to fold in.

## 6. Team-name normalization — **pending owner build**
[data] · Canonical alias map (RCB Bangalore/Bengaluru, India/India Men, St/Saint Lucia). **Owner note:**
owner will build this in an outside project ("team registry") and add it in, like the player registry.

## 7. Per-over data layer — **pending owner decision**
[data] · Lazy-loaded per-over parquet + a per-over Line X-axis (over 1→20). Absorbs the old R5-E.
Add per-over aggregates in `export_parquet.py` (source `deliveries` has `over_number`; 11.3 M ball rows),
expose **per-over** as a Line X-dimension (Y aggregated per over). **SIZE CONCERN:** a full per-over parquet
is ~**8× batting** (3.4 M rows) / ~**6× bowling** (1.9 M rows) and feeds only the one Line axis → must be
built **lean** (only Line-needed fields, sorted by player) and loaded **only when the per-over axis is
picked**. Owner rule: "measure the real size before committing." Test-first/gated/additive pattern (like
decision 36's phase/matchup extension); publishes to R2 via CI → needs owner's explicit go for the
pipeline run.

## 8. Graphs on mobile — **pending spec**
[app] · Determine how each chart type behaves at phone widths (375px). Dense-label charts drop value
labels; sidebar controls stack full-width. Needs per-chart-type sizing rules.

## 9. ~375px mobile one-screen fit — **pending CSS audit**
[app] · Final CSS tightening to fit the left-column + chart on one viewport at 375px width. Known residual:
outer horizontal scroll not yet eliminated (owner deferred Wave 1).

## 10. Player pop-up — full determination — **pending spec**
[app] · Decide the player pop-up in full (owner 2026-07-23): which GRAPHS go into it and HOW they're shown,
plus a review of the stat blocks it currently shows. The popup's stat blocks are to be **linked to the Stats
table's column-group dropdown (Core / Boundaries / Dismissals / Phases / Progression) BY FORMAT**, so the two
stay consistent. Depends on #4 (the column-group metric definitions). Note: the Donut chart is retained
specifically for the popup, so its role here is part of this spec.

## 11. Full design re-do with incoming brand kit — **comes LAST**
[design] · Aesthetic layer only; all functional rules already shipped. Once the brand kit arrives (colors,
typefaces, spacing), apply to the entire UI + export card per §1 (CHART_SYSTEM.md). Lowest priority.

## 12. Load-speed Tiers 2–4 — **pending discussion**
[data] [app] · **Tier 1 DONE** (Cloudflare custom domain + immutable caching). Remaining (in bang-for-buck order):
- **Tier 2 — shrink the bytes** (pipeline-only; `export_parquet.py`): **ZSTD is already applied** (since
  Phase 0 — not a to-do). Remaining: sort rows to match the default query order (biggest win for the 23 MB
  matchup pair); column pruning (audit which columns the browser never reads). Verify anchors stay EXACT via
  independent DuckDB per file.
- **Tier 3 — smarter loading** (app-side, moderate): background-warm batting file while filtering; persist
  parquets in IndexedDB/OPFS with hash-based re-fetch.
- **Tier 4 — restructure data** (bigger surgery; only if 1–3 insufficient): split parquets by gender/format;
  precomputed "default leaderboard" (CAVEAT: changes *where numbers come from* → collides with numbers-sacred
  rule → last resort, needs heavy verification).

**Owner note:** needs a discussion of how the system works to decide tweaks vs a complete overhaul.

## 13. File-split — **pending discussion**
[app] · Split the 5 oversized files (graph.js ~3,960 lines, table.js ~2,750, metrics.js ~1,820,
charts.js ~1,120, styles.css ~4,570) per FILE_SPLIT_PLAN.md. Staged split, no rush. **Owner note:** needs a
discussion of how the system works to decide tweaks vs a complete overhaul.

---

## Deleted (do not include)
- #18 personal-data coverage note — owned by design/final review, not backlog
- #19 fresh-load red outline — built per R5-C spec, currently live
- Line "literal break" option — owner ruled spans (`spanGaps:true`) the standard
